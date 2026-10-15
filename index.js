import { saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

// 扩展唯一标识与持久化键
const EXTENSION_NAME = 'third-party/SillyTavern-FloorNav';
const SETTINGS_KEY = 'floorNav';
const LOCAL_STORAGE_KEY = 'st_floornav_settings';

// 默认配置
const defaultSettings = {
    enableCollapse: true,
    collapseHeight: 300,
    autoCollapse: false,
    autoCollapseFromN: 2, // 从倒数第几条消息开始生效，默认 2 (即最后一楼保持展开，更早历史楼层自动收起)
    enableJump: true,
    previewLength: 20,
    enableTagCheck: true, // 是否启用标签检查与红色警示提醒
    checkTags: '<text>', // 检查的标签列表，支持逗号或空格分隔，如 <text>, <a>, <b> 或 text, code
    tagCheckMode: 'required', // 默认模式 B：强制必填 ('required')；可选模式 A：成对闭合 ('pair')
    tagCheckOnlyAi: true, // 仅对 AI 角色回复生效
};

// 内存中激活的配置
let activeSettings = { ...defaultSettings };

// 运行时状态
let isPanelOpen = false;
let isGenerating = false;
let mutationObserver = null;

/**
 * 获取 SillyTavern 全局上下文
 */
function getStContext() {
    return window.SillyTavern?.getContext ? window.SillyTavern.getContext() : {};
}

/**
 * 从 localStorage 读取本地持久化配置
 * @returns {object|null}
 */
function readLocalStorageSettings() {
    try {
        const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (raw) {
            return JSON.parse(raw);
        }
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] 读取本地设置失败:`, e);
    }
    return null;
}

/**
 * 写入本地 localStorage 持久化存储
 * @param {object} settings 
 */
function writeLocalStorageSettings(settings) {
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] 写入本地设置失败:`, e);
    }
}

/**
 * 获取并深度合并配置（优先级：localStorage > extension_settings > defaultSettings）
 */
function getSettings() {
    const local = readLocalStorageSettings();
    const server = extension_settings[SETTINGS_KEY];

    activeSettings = Object.assign({}, defaultSettings, server || {}, local || {});

    // 同步回全局 extension_settings，保证随系统一同备份
    extension_settings[SETTINGS_KEY] = activeSettings;
    return activeSettings;
}

/**
 * 保存配置（同时写入 localStorage、extension_settings 并同步到服务端）
 * @param {boolean} immediate 是否立即强制写入服务端（不走防抖）
 */
function persistSettings(immediate = false) {
    // 1. 同步写入 localStorage（0ms，保证刷新绝对不丢）
    writeLocalStorageSettings(activeSettings);

    // 2. 写入全局 extension_settings
    extension_settings[SETTINGS_KEY] = activeSettings;

    // 3. 提交给 SillyTavern 后端存储
    if (immediate) {
        saveSettings();
    } else {
        saveSettingsDebounced();
    }
}

/**
 * 实时同步 CSS 变量到全局 documentElement，确保已折叠楼层高度毫秒级响应
 * @param {number} height 
 */
function applyGlobalCollapseHeight(height) {
    const val = Number(height) || 300;
    document.documentElement.style.setProperty('--st-floor-collapse-height', `${val}px`);
}

/**
 * 准确获取消息在未被 CSS 截断时的真实内容高度
 * @param {HTMLElement} mesElement 
 * @param {HTMLElement} mesText 
 * @returns {number}
 */
function getRealMessageContentHeight(mesElement, mesText) {
    if (!mesElement.classList.contains('st-floor-collapsed')) {
        return Math.max(mesText.scrollHeight, mesText.offsetHeight);
    }

    // 若消息已折叠，测量其子内容的实际累积高度
    let totalChildrenHeight = 0;
    Array.from(mesText.children).forEach(child => {
        if (child instanceof HTMLElement) {
            totalChildrenHeight += child.offsetHeight + parseInt(window.getComputedStyle(child).marginBottom || '0', 10);
        }
    });

    if (totalChildrenHeight > 0) {
        return totalChildrenHeight;
    }

    // 备用方案：临时测量真实高度
    const originalMaxHeight = mesText.style.maxHeight;
    mesText.style.maxHeight = 'none';
    const realHeight = mesText.scrollHeight;
    mesText.style.maxHeight = originalMaxHeight;
    return realHeight;
}

/**
 * 清理富文本与Markdown标记，生成纯文本预览
 * @param {string} rawHtml 
 * @param {number} maxLen 
 * @returns {string}
 */
function getCleanTextPreview(rawHtml, maxLen = 20) {
    if (!rawHtml) return '...';

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = rawHtml;

    // 移除思维链 / reasoning / details 等内部思考节点
    const reasonings = tempDiv.querySelectorAll('.mes_reasoning_details, details, script, style');
    reasonings.forEach(el => el.remove());

    let text = tempDiv.textContent || tempDiv.innerText || '';

    // 清理常见 Markdown 标记及格式符号
    text = text
        .replace(/```[\s\S]*?```/g, ' [代码] ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[.*?\]\(.*?\)/g, ' [图片] ')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/[*_~#>`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!text) {
        if (tempDiv.querySelector('img')) return '[图片消息]';
        return '...';
    }

    if (text.length > maxLen) {
        return text.substring(0, maxLen) + '...';
    }
    return text;
}

/**
 * 解析用户配置的标签字符串为纯标签名数组
 * 例如输入 "<text>, <a>, <b>" 或 "text, a, b" -> ['text', 'a', 'b']
 * @param {string} tagsStr 
 * @returns {string[]}
 */
function parseConfiguredTags(tagsStr) {
    if (!tagsStr || typeof tagsStr !== 'string') return [];
    const parts = tagsStr.split(/[,;\s\n\r，；]+/);
    const tags = [];
    for (let p of parts) {
        const clean = p.replace(/^[<</]+|[>]+$/g, '').trim().toLowerCase();
        if (clean && /^[a-zA-Z0-9_\-:]+$/.test(clean)) {
            if (!tags.includes(clean)) {
                tags.push(clean);
            }
        }
    }
    return tags;
}

/**
 * 判断指定楼层是否属于 AI 角色消息
 * @param {HTMLElement} mesElement 
 * @returns {boolean}
 */
function isAiMessage(mesElement) {
    const mesIdStr = mesElement.getAttribute('mesid');
    const context = getStContext();
    if (mesIdStr !== null && mesIdStr !== undefined && context?.chat) {
        const mesId = parseInt(mesIdStr, 10);
        if (!isNaN(mesId) && context.chat[mesId]) {
            const chatItem = context.chat[mesId];
            return !chatItem.is_user && !chatItem.is_system;
        }
    }
    const isUser = mesElement.getAttribute('is_user') === 'true' || mesElement.classList.contains('is_user');
    const isSystem = mesElement.getAttribute('is_system') === 'true' || mesElement.classList.contains('is_system');
    return !isUser && !isSystem;
}

/**
 * 获取消息的真实原始文本（优先从 SillyTavern 全局 chat 数组读取，确保无 DOM 自动修复干扰）
 * @param {HTMLElement} mesElement 
 * @returns {string}
 */
function getMessageRawText(mesElement) {
    const mesIdStr = mesElement.getAttribute('mesid');
    const context = getStContext();
    if (mesIdStr !== null && mesIdStr !== undefined && context?.chat) {
        const mesId = parseInt(mesIdStr, 10);
        if (!isNaN(mesId) && context.chat[mesId]) {
            const chatItem = context.chat[mesId];
            if (typeof chatItem.mes === 'string') {
                return chatItem.mes;
            }
        }
    }

    const mesText = mesElement.querySelector('.mes_text');
    return mesText ? (mesText.textContent || mesText.innerText || '') : '';
}

/**
 * 检查指定楼层的标签完整性
 * @param {HTMLElement} mesElement 
 * @param {object} settings 
 * @returns {{hasError: boolean, errors: Array<{tag: string, type: string, msg: string}>, summaryText: string, detailText: string}}
 */
function checkMessageTags(mesElement, settings) {
    if (!settings.enableTagCheck) {
        return { hasError: false, errors: [], summaryText: '', detailText: '' };
    }

    if (settings.tagCheckOnlyAi && !isAiMessage(mesElement)) {
        return { hasError: false, errors: [], summaryText: '', detailText: '' };
    }

    const configuredTags = parseConfiguredTags(settings.checkTags);
    if (configuredTags.length === 0) {
        return { hasError: false, errors: [], summaryText: '', detailText: '' };
    }

    const rawText = getMessageRawText(mesElement);
    const mode = settings.tagCheckMode || 'required';
    const errors = [];

    const escapeRegex = (s) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    for (const t of configuredTags) {
        const escaped = escapeRegex(t);

        // 检测末尾截断（例如以 `<text` 或 `</text` 结尾但未闭合 `>`）
        const tailIncomplete = new RegExp(`<\/?${escaped}(?:\\s+[^>]*)?$`, 'i').test(rawText) && !rawText.trimEnd().endsWith('>');

        let openCount = 0;
        let closeCount = 0;
        let orderError = false;

        const regex = new RegExp(`(<\\/?)(${escaped})(\\s+[^>]*)?(\\/?>)`, 'gi');
        let match;
        while ((match = regex.exec(rawText)) !== null) {
            const isClosing = match[1] === '</';
            const isSelfClosing = match[4] === '/>';

            if (isSelfClosing) {
                openCount++;
                closeCount++;
            } else if (isClosing) {
                closeCount++;
                if (closeCount > openCount) {
                    orderError = true;
                }
            } else {
                openCount++;
            }
        }

        if (mode === 'required') {
            // 模式 B：强制必填（必须包含且成对完整）
            if (openCount === 0 && closeCount === 0 && !tailIncomplete) {
                errors.push({ tag: t, type: 'missing_all', msg: `缺少 <${t}> 标签` });
            } else if (tailIncomplete) {
                errors.push({ tag: t, type: 'tail_incomplete', msg: `<${t}> 标签末尾被截断/未闭合` });
            } else if (openCount > closeCount) {
                const diff = openCount - closeCount;
                errors.push({ tag: t, type: 'missing_close', msg: `缺少 </${t}> 闭合标签` + (diff > 1 ? ` (${diff}处)` : '') });
            } else if (openCount < closeCount) {
                const diff = closeCount - openCount;
                errors.push({ tag: t, type: 'missing_open', msg: `缺少 <${t}> 开始标签` + (diff > 1 ? ` (${diff}处)` : '') });
            } else if (orderError) {
                errors.push({ tag: t, type: 'order_error', msg: `<${t}> 标签闭合顺序颠倒` });
            }
        } else {
            // 模式 A：出现即闭合（若未出现则不强制报错）
            if (openCount === 0 && closeCount === 0 && !tailIncomplete) {
                // 未出现此标签，正常
            } else if (tailIncomplete) {
                errors.push({ tag: t, type: 'tail_incomplete', msg: `<${t}> 标签末尾被截断/未闭合` });
            } else if (openCount > closeCount) {
                const diff = openCount - closeCount;
                errors.push({ tag: t, type: 'missing_close', msg: `缺少 </${t}> 闭合标签` + (diff > 1 ? ` (${diff}处)` : '') });
            } else if (openCount < closeCount) {
                const diff = closeCount - openCount;
                errors.push({ tag: t, type: 'missing_open', msg: `缺少 <${t}> 开始标签` + (diff > 1 ? ` (${diff}处)` : '') });
            } else if (orderError) {
                errors.push({ tag: t, type: 'order_error', msg: `<${t}> 标签闭合顺序颠倒` });
            }
        }
    }

    if (errors.length === 0) {
        return { hasError: false, errors: [], summaryText: '', detailText: '' };
    }

    // 生成紧凑简报
    let summaryText = '';
    if (errors.length === 1) {
        summaryText = errors[0].msg;
    } else {
        const shortTags = errors.map(e => e.type === 'missing_close' ? `</${e.tag}>` : `<${e.tag}>`).join(', ');
        if (shortTags.length <= 22) {
            summaryText = `缺少 ${shortTags}`;
        } else {
            summaryText = `标签异常 (${errors.length}处)`;
        }
    }

    const detailLines = ['【AI 标签完整性检查异常】', ...errors.map(e => `• ${e.msg}`)];
    const detailText = detailLines.join('\n');

    return {
        hasError: true,
        errors,
        summaryText,
        detailText,
    };
}

/**
 * 创建折叠控制行 DOM
 * @param {HTMLElement} mesElement 
 * @returns {HTMLElement}
 */
function createCollapseRow(mesElement) {
    const collapseRow = document.createElement('div');
    collapseRow.className = 'st-floor-collapse-row';
    collapseRow.innerHTML = `
        <button type="button" class="st-floor-collapse-btn">
            <i class="fa-solid fa-chevron-up"></i>
            <span class="st-floor-collapse-label">收起楼层</span>
        </button>
        <div class="st-floor-tag-badge" style="display: none;">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span class="st-floor-tag-badge-text"></span>
        </div>
    `;

    const btn = collapseRow.querySelector('.st-floor-collapse-btn');
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMessageCollapse(mesElement);
    });

    const badge = collapseRow.querySelector('.st-floor-tag-badge');
    badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const info = badge.getAttribute('data-err-info') || '标签不完整';
        if (window.toastr) {
            window.toastr.warning(info.replace(/\n/g, '<br>'), '标签完整性提示');
        }
    });

    return collapseRow;
}

/**
 * 检查并更新单个消息楼层的折叠状态及标签完整性检查
 * @param {HTMLElement} mesElement 
 * @param {boolean} shouldAutoCollapse 是否符合“从倒数第N楼开始自动收起”的条件
 * @param {boolean} forceRecalculateAutoCollapse 是否重新应用自动收起规则（如设置项修改时立即生效）
 */
function updateMessageCollapse(mesElement, shouldAutoCollapse = false, forceRecalculateAutoCollapse = false) {
    if (!mesElement || !(mesElement instanceof HTMLElement)) return;

    const settings = getSettings();
    const mesBlock = mesElement.querySelector('.mes_block');
    const mesText = mesElement.querySelector('.mes_text');
    if (!mesBlock || !mesText) return;

    let collapseRow = mesBlock.querySelector('.st-floor-collapse-row');
    if (!collapseRow) {
        collapseRow = createCollapseRow(mesElement);
        mesBlock.appendChild(collapseRow);
    }

    const collapseBtn = collapseRow.querySelector('.st-floor-collapse-btn');
    const tagBadge = collapseRow.querySelector('.st-floor-tag-badge');

    // 1. 检查楼层折叠高度
    let showCollapseBtn = false;
    if (settings.enableCollapse) {
        const threshold = Number(settings.collapseHeight) || 300;
        const realHeight = getRealMessageContentHeight(mesElement, mesText);
        const isOverHeight = realHeight > threshold;

        if (isOverHeight) {
            showCollapseBtn = true;
            if (settings.autoCollapse) {
                if (shouldAutoCollapse) {
                    if (forceRecalculateAutoCollapse || mesElement.getAttribute('data-user-action') !== 'expanded') {
                        mesElement.classList.add('st-floor-collapsed');
                        mesElement.setAttribute('data-st-collapsed-by', 'auto');
                        if (forceRecalculateAutoCollapse) {
                            mesElement.removeAttribute('data-user-action');
                        }
                    }
                } else {
                    if (forceRecalculateAutoCollapse || mesElement.getAttribute('data-st-collapsed-by') === 'auto') {
                        if (mesElement.getAttribute('data-user-action') !== 'collapsed') {
                            mesElement.classList.remove('st-floor-collapsed');
                            mesElement.removeAttribute('data-st-collapsed-by');
                        }
                    }
                }
            } else {
                if (forceRecalculateAutoCollapse || mesElement.getAttribute('data-st-collapsed-by') === 'auto') {
                    if (mesElement.getAttribute('data-user-action') !== 'collapsed') {
                        mesElement.classList.remove('st-floor-collapsed');
                        mesElement.removeAttribute('data-st-collapsed-by');
                    }
                }
            }
            updateCollapseButtonState(mesElement);
        } else {
            // 未超高楼层：展开并清理折叠标记
            mesElement.classList.remove('st-floor-collapsed');
            mesElement.removeAttribute('data-st-collapsed-by');
        }
    } else {
        // 全局禁用折叠
        mesElement.classList.remove('st-floor-collapsed');
        mesElement.removeAttribute('data-st-collapsed-by');
    }

    if (collapseBtn) {
        collapseBtn.style.display = showCollapseBtn ? 'inline-flex' : 'none';
    }

    // 2. 检查标签完整性（即使楼层未超高，也会在楼层底部显示红色警示徽章）
    let showTagBadge = false;
    if (settings.enableTagCheck) {
        const tagResult = checkMessageTags(mesElement, settings);
        if (tagResult.hasError) {
            showTagBadge = true;
            if (tagBadge) {
                tagBadge.style.display = 'inline-flex';
                const label = tagBadge.querySelector('.st-floor-tag-badge-text');
                if (label) label.textContent = tagResult.summaryText;
                tagBadge.title = tagResult.detailText;
                tagBadge.setAttribute('data-err-info', tagResult.detailText);
            }
            mesElement.setAttribute('data-st-tag-error', tagResult.summaryText);
        } else {
            if (tagBadge) tagBadge.style.display = 'none';
            mesElement.removeAttribute('data-st-tag-error');
        }
    } else {
        if (tagBadge) tagBadge.style.display = 'none';
        mesElement.removeAttribute('data-st-tag-error');
    }

    // 3. 控制整行显隐（只要有折叠按钮或有标签报警，均展示该行）
    if (showCollapseBtn || showTagBadge) {
        collapseRow.style.display = 'flex';
    } else {
        collapseRow.style.display = 'none';
    }
}

/**
 * 切换某楼层的收起/展开
 * @param {HTMLElement} mesElement 
 */
function toggleMessageCollapse(mesElement) {
    const isCollapsed = mesElement.classList.toggle('st-floor-collapsed');
    // 记录用户的明确手动意图（手动折叠 或 手动展开）
    mesElement.setAttribute('data-user-action', isCollapsed ? 'collapsed' : 'expanded');
    mesElement.removeAttribute('data-st-collapsed-by');
    updateCollapseButtonState(mesElement);

    // 点击收起时平滑将消息头部带入可视区域，防止画面突然空白
    if (isCollapsed) {
        mesElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/**
 * 更新按钮文案与图标状态
 * @param {HTMLElement} mesElement 
 */
function updateCollapseButtonState(mesElement) {
    const isCollapsed = mesElement.classList.contains('st-floor-collapsed');
    const btn = mesElement.querySelector('.st-floor-collapse-btn');
    if (!btn) return;

    const icon = btn.querySelector('i');
    const label = btn.querySelector('.st-floor-collapse-label');

    if (isCollapsed) {
        if (icon) icon.className = 'fa-solid fa-chevron-down';
        if (label) label.textContent = '展开楼层';
        btn.title = '展开查看完整内容';
    } else {
        if (icon) icon.className = 'fa-solid fa-chevron-up';
        if (label) label.textContent = '收起楼层';
        btn.title = '收起当前楼层为精简高度';
    }
}

/**
 * 全量刷新所有楼层的收起检查与自动收起策略
 * @param {boolean} forceRecalculateAutoCollapse 是否重新应用自动收起规则（如设置项修改时立即生效）
 */
function refreshAllCollapses(forceRecalculateAutoCollapse = false) {
    const chatContainer = document.querySelector('#chat');
    if (!chatContainer) return;

    // 筛选可见的有效楼层（排除系统隐藏节点）
    const messages = Array.from(chatContainer.querySelectorAll('.mes')).filter(el => {
        return el.style.display !== 'none';
    });

    const total = messages.length;
    const settings = getSettings();
    const fromN = Math.max(1, Number(settings.autoCollapseFromN) || 2);

    let collapsedCount = 0;
    let tagErrorCount = 0;

    messages.forEach((mes, index) => {
        // 该楼层处于倒数第几位（最新一条为倒数第 1）
        const fromEndIndex = total - index;
        // 是否符合自动收起条件：开启了自动收起，且当前楼层处于倒数第 N 楼或更早
        const shouldAutoCollapse = settings.autoCollapse && (fromEndIndex >= fromN);

        updateMessageCollapse(mes, shouldAutoCollapse, forceRecalculateAutoCollapse);

        if (mes.classList.contains('st-floor-collapsed')) {
            collapsedCount++;
        }
        if (mes.hasAttribute('data-st-tag-error')) {
            tagErrorCount++;
        }
    });

    console.log(`[${EXTENSION_NAME}] 刷新楼层: 共 ${total} 楼, 已收起: ${collapsedCount} 楼, 标签异常: ${tagErrorCount} 楼`);

    updateNavTriggerCount();
}

/**
 * 直接平滑滚动到最后一条消息的头部
 */
function scrollToLastMessageHeader() {
    const chatContainer = document.querySelector('#chat');
    if (!chatContainer) return;

    const messages = Array.from(chatContainer.querySelectorAll('.mes')).filter(el => el.style.display !== 'none');
    if (messages.length === 0) return;

    const lastMes = messages[messages.length - 1];
    lastMes.scrollIntoView({ behavior: 'smooth', block: 'start' });
    highlightMessage(lastMes);
}

/**
 * 构建并注入输入区上方的悬浮工具栏（包含向下直达末尾按钮与跳转按钮）
 */
function injectFloatingNavButton() {
    const settings = getSettings();
    let toolbar = document.querySelector('#st-floor-nav-toolbar');
    const formSheld = document.querySelector('#form_sheld');

    if (!formSheld) return;

    if (!settings.enableJump) {
        if (toolbar) toolbar.remove();
        closeNavPanel();
        return;
    }

    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'st-floor-nav-toolbar';
        toolbar.innerHTML = `
            <div id="st-floor-scroll-bottom-btn" class="st-floor-floating-btn interactable" title="直接滚动到最后一条消息的头部">
                <i class="fa-solid fa-chevron-down"></i>
            </div>
            <div id="st-floor-nav-trigger" class="st-floor-floating-btn interactable" title="点击查看楼层列表并快速跳转">
                <span>跳转</span>
            </div>
        `;

        // 点击向下箭头：直接滚动到最后一条消息的头部
        toolbar.querySelector('#st-floor-scroll-bottom-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            scrollToLastMessageHeader();
        });

        // 点击跳转按钮：呼出/收起楼层列表
        toolbar.querySelector('#st-floor-nav-trigger').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleNavPanel();
        });

        formSheld.appendChild(toolbar);
    } else {
        const trigger = toolbar.querySelector('#st-floor-nav-trigger');
        if (trigger) {
            trigger.innerHTML = `<span>跳转</span>`;
        }
    }

    updateNavTriggerCount();
}

/**
 * 更新悬浮按钮提示信息
 */
function updateNavTriggerCount() {
    const trigger = document.querySelector('#st-floor-nav-trigger');
    if (!trigger) return;

    const messages = document.querySelectorAll('#chat .mes');
    const errCount = document.querySelectorAll('#chat .mes[data-st-tag-error]').length;
    if (errCount > 0) {
        trigger.title = `点击查看楼层列表 (共 ${messages.length} 楼, ${errCount} 楼存在标签异常)`;
    } else {
        trigger.title = `点击查看楼层列表并快速跳转 (共 ${messages.length} 楼)`;
    }
}

/**
 * 确保楼层导航面板已构建
 */
function ensureNavPanel() {
    let panel = document.querySelector('#st-floor-nav-panel');
    if (panel) return panel;

    const formSheld = document.querySelector('#form_sheld') || document.body;

    panel = document.createElement('div');
    panel.id = 'st-floor-nav-panel';
    panel.className = 'st-hidden';
    panel.innerHTML = `
        <div class="st-floor-panel-header">
            <div class="st-floor-panel-title">
                <i class="fa-solid fa-compass"></i>
                <span class="st-floor-title-text">楼层快速导航</span>
            </div>
            <div class="st-floor-panel-actions">
                <button type="button" class="st-floor-action-btn st-nav-top-btn" title="滚动到顶部(第1楼)">
                    <i class="fa-solid fa-arrow-up-to-line"></i>
                </button>
                <button type="button" class="st-floor-action-btn st-nav-bottom-btn" title="滚动到底部(最新楼)">
                    <i class="fa-solid fa-arrow-down-to-line"></i>
                </button>
                <button type="button" class="st-floor-action-btn st-nav-collapse-all-btn" title="全部收起/全部展开">
                    <i class="fa-solid fa-compress"></i>
                </button>
                <button type="button" class="st-floor-action-btn st-nav-close-btn" title="关闭面板">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div class="st-floor-search-bar">
            <i class="fa-solid fa-magnifying-glass opacity50p"></i>
            <input type="text" class="st-floor-search-input" placeholder="搜索楼层内容或发送者...">
        </div>
        <div class="st-floor-list-container">
            <!-- 楼层 items 动态渲染 -->
        </div>
    `;

    // 关闭按钮
    panel.querySelector('.st-nav-close-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        closeNavPanel();
    });

    // 一键回到顶部
    panel.querySelector('.st-nav-top-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const firstMes = document.querySelector('#chat .mes:first-child');
        if (firstMes) {
            firstMes.scrollIntoView({ behavior: 'smooth', block: 'start' });
            highlightMessage(firstMes);
        }
    });

    // 一键回到底部
    panel.querySelector('.st-nav-bottom-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const lastMes = document.querySelector('#chat .mes:last-child');
        if (lastMes) {
            lastMes.scrollIntoView({ behavior: 'smooth', block: 'end' });
            highlightMessage(lastMes);
        }
    });

    // 一键全部收起/全部展开
    let allCollapsed = false;
    panel.querySelector('.st-nav-collapse-all-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        allCollapsed = !allCollapsed;
        const messages = document.querySelectorAll('#chat .mes');
        messages.forEach(mes => {
            const hasBtn = mes.querySelector('.st-floor-collapse-row');
            if (hasBtn && hasBtn.style.display !== 'none') {
                if (allCollapsed) {
                    mes.classList.add('st-floor-collapsed');
                } else {
                    mes.classList.remove('st-floor-collapsed');
                }
                updateCollapseButtonState(mes);
            }
        });
        const icon = panel.querySelector('.st-nav-collapse-all-btn i');
        if (icon) {
            icon.className = allCollapsed ? 'fa-solid fa-expand' : 'fa-solid fa-compress';
        }
    });

    // 搜索实时过滤
    const searchInput = panel.querySelector('.st-floor-search-input');
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase().trim();
        const items = panel.querySelectorAll('.st-floor-item');
        items.forEach(item => {
            const text = item.getAttribute('data-search') || '';
            if (!query || text.includes(query)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    });

    // 阻止面板内点击冒泡
    panel.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    formSheld.appendChild(panel);
    return panel;
}

/**
 * 切换导航面板显隐
 */
function toggleNavPanel() {
    if (isPanelOpen) {
        closeNavPanel();
    } else {
        openNavPanel();
    }
}

/**
 * 打开导航面板并刷新列表
 */
function openNavPanel() {
    const panel = ensureNavPanel();
    const trigger = document.querySelector('#st-floor-nav-trigger');

    renderFloorList();
    panel.classList.remove('st-hidden');
    if (trigger) trigger.classList.add('active');
    isPanelOpen = true;

    const searchInput = panel.querySelector('.st-floor-search-input');
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
}

/**
 * 关闭导航面板
 */
function closeNavPanel() {
    const panel = document.querySelector('#st-floor-nav-panel');
    const trigger = document.querySelector('#st-floor-nav-trigger');
    if (panel) {
        panel.classList.add('st-hidden');
    }
    if (trigger) {
        trigger.classList.remove('active');
    }
    isPanelOpen = false;
}

/**
 * 渲染楼层列表内容
 */
function renderFloorList() {
    const panel = ensureNavPanel();
    const listContainer = panel.querySelector('.st-floor-list-container');
    const titleText = panel.querySelector('.st-floor-title-text');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    const messages = Array.from(document.querySelectorAll('#chat .mes'));
    const settings = getSettings();
    const previewLen = Number(settings.previewLength) || 20;

    if (titleText) {
        titleText.textContent = `楼层快速导航 (${messages.length})`;
    }

    if (messages.length === 0) {
        listContainer.innerHTML = '<div class="st-floor-empty-tip">暂无聊天记录</div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    messages.forEach((mes, index) => {
        const floorNumber = index + 1;
        const mesId = mes.getAttribute('mesid') || index;
        const charName = mes.getAttribute('ch_name') || mes.querySelector('.name_text')?.textContent || '未知';
        const isUser = mes.getAttribute('is_user') === 'true';
        const isSystem = mes.getAttribute('is_system') === 'true';

        let roleClass = 'st-floor-role-char';
        let roleText = 'AI';
        if (isUser) {
            roleClass = 'st-floor-role-user';
            roleText = '你';
        } else if (isSystem) {
            roleClass = 'st-floor-role-system';
            roleText = '系统';
        }

        const mesTextEl = mes.querySelector('.mes_text');
        const rawContent = mesTextEl ? mesTextEl.innerHTML : '';
        const preview = getCleanTextPreview(rawContent, previewLen);

        const tagError = mes.getAttribute('data-st-tag-error');
        const errTagHtml = tagError ? `<span class="st-floor-item-err-tag" title="标签异常: ${tagError}"><i class="fa-solid fa-triangle-exclamation"></i> ${tagError}</span>` : '';

        const item = document.createElement('div');
        item.className = 'st-floor-item';
        item.setAttribute('data-mesid', mesId);
        item.setAttribute('data-search', `${floorNumber} ${charName} ${preview} ${tagError || ''}`.toLowerCase());

        item.innerHTML = `
            <div class="st-floor-item-badge">#${floorNumber}</div>
            <div class="st-floor-item-main">
                <div class="st-floor-item-header">
                    <span class="st-floor-item-role-tag ${roleClass}">${roleText}</span>
                    <span class="st-floor-item-name" title="${charName}">${charName}</span>
                    ${errTagHtml}
                </div>
                <div class="st-floor-item-preview" title="${preview}">${preview}</div>
            </div>
        `;

        item.addEventListener('click', () => {
            scrollToMessage(mes);
            if (window.innerWidth < 768) {
                closeNavPanel();
            }
        });

        fragment.appendChild(item);
    });

    listContainer.appendChild(fragment);
}

/**
 * 平滑滚动到指定消息并闪烁高亮
 * @param {HTMLElement} mesElement 
 */
function scrollToMessage(mesElement) {
    if (!mesElement) return;

    mesElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightMessage(mesElement);
}

/**
 * 给楼层添加平滑发光高亮动画
 * @param {HTMLElement} mesElement 
 */
function highlightMessage(mesElement) {
    mesElement.classList.remove('st-floor-nav-highlight');
    void mesElement.offsetWidth;
    mesElement.classList.add('st-floor-nav-highlight');

    setTimeout(() => {
        mesElement.classList.remove('st-floor-nav-highlight');
    }, 2000);
}

/**
 * 监听全局点击事件，实现点击面板外部自动收起
 */
function setupOutsideClickListener() {
    document.addEventListener('click', (e) => {
        if (!isPanelOpen) return;
        const panel = document.querySelector('#st-floor-nav-panel');
        const toolbar = document.querySelector('#st-floor-nav-toolbar');

        if (panel && !panel.contains(e.target) && (!toolbar || !toolbar.contains(e.target))) {
            closeNavPanel();
        }
    });
}

/**
 * 初始化 DOM 监听器（过滤自身变动并防抖）
 */
function setupObservers() {
    const chatContainer = document.querySelector('#chat');
    if (!chatContainer) return;

    let debounceTimer = null;
    mutationObserver = new MutationObserver((mutations) => {
        // 如果正在生成中，不打断流式渲染
        if (isGenerating) return;

        // 检查是否有实质性的 .mes 增删变动，忽略插件自身的按钮插入
        let hasRelevantChange = false;
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const node of m.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.classList?.contains('st-floor-collapse-row')) continue;
                        if (node.classList?.contains('mes') || node.querySelector?.('.mes')) {
                            hasRelevantChange = true;
                            break;
                        }
                    }
                }
                for (const node of m.removedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && (node.classList?.contains('mes') || node.querySelector?.('.mes'))) {
                        hasRelevantChange = true;
                        break;
                    }
                }
            }
            if (hasRelevantChange) break;
        }

        if (hasRelevantChange) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                refreshAllCollapses(false);
                if (isPanelOpen) renderFloorList();
            }, 180);
        }
    });

    mutationObserver.observe(chatContainer, {
        childList: true,
        subtree: true,
        attributes: false,
    });

    // 监听图片异步加载撑大高度
    chatContainer.addEventListener('load', (e) => {
        if (e.target && e.target.tagName === 'IMG') {
            const mes = e.target.closest('.mes');
            if (mes) {
                const total = document.querySelectorAll('#chat .mes').length;
                const index = Array.from(document.querySelectorAll('#chat .mes')).indexOf(mes);
                const settings = getSettings();
                const fromN = Math.max(1, Number(settings.autoCollapseFromN) || 2);
                const fromEndIndex = total - index;
                const shouldAutoCollapse = settings.autoCollapse && (fromEndIndex >= fromN);
                updateMessageCollapse(mes, shouldAutoCollapse, false);
            }
        }
    }, true);
}

/**
 * 同步当前设置对象到 HTML 控件中
 */
function syncSettingsToUI() {
    const settings = getSettings();

    $('#st_floor_enable_collapse').prop('checked', settings.enableCollapse);
    $('#st_floor_collapse_height').val(settings.collapseHeight);
    $('#st_floor_collapse_height_value').text(`${settings.collapseHeight}px`);
    $('#st_floor_auto_collapse').prop('checked', settings.autoCollapse);
    $('#st_floor_auto_n').val(settings.autoCollapseFromN ?? 2);
    $('#st_floor_enable_jump').prop('checked', settings.enableJump);
    $('#st_floor_preview_len').val(settings.previewLength);
    $('#st_floor_preview_len_value').text(`${settings.previewLength}字`);

    const block = $('#st_floor_auto_n_block');
    if (settings.autoCollapse) {
        block.css({ opacity: '1', 'pointer-events': 'auto' });
    } else {
        block.css({ opacity: '0.4', 'pointer-events': 'none' });
    }

    // 标签检查配置同步
    $('#st_floor_enable_tag_check').prop('checked', settings.enableTagCheck ?? true);
    $('#st_floor_check_tags').val(settings.checkTags || '<text>');
    $('#st_floor_tag_check_mode').val(settings.tagCheckMode || 'required');
    $('#st_floor_tag_check_only_ai').prop('checked', settings.tagCheckOnlyAi ?? true);

    const tagSubgroup = $('#st_floor_tag_check_subgroup');
    if (settings.enableTagCheck ?? true) {
        tagSubgroup.css({ opacity: '1', 'pointer-events': 'auto' });
    } else {
        tagSubgroup.css({ opacity: '0.4', 'pointer-events': 'none' });
    }

    applyGlobalCollapseHeight(settings.collapseHeight);
}

/**
 * 加载并注册扩展设置面板
 */
async function setupSettings() {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
        const targetContainer = $('#extensions_settings');

        if (targetContainer.length) {
            targetContainer.append(settingsHtml);
        }

        // 1. 同步初始值到 UI
        syncSettingsToUI();

        // 2. 启用收起按钮
        $('#st_floor_enable_collapse').off('change').on('change', function () {
            activeSettings.enableCollapse = $(this).prop('checked');
            persistSettings(false);
            refreshAllCollapses(true);
        });

        // 3. 收起高度滑块（input 与 change 均实时响应，毫秒生效）
        const onHeightChange = function () {
            const val = Number($(this).val()) || 300;
            $('#st_floor_collapse_height_value').text(`${val}px`);
            activeSettings.collapseHeight = val;
            applyGlobalCollapseHeight(val);
            refreshAllCollapses(false);
            persistSettings(false);
        };

        $('#st_floor_collapse_height')
            .off('input change')
            .on('input', onHeightChange)
            .on('change', onHeightChange);

        // 4. 自动收起开关与倒数 N 楼联动
        $('#st_floor_auto_collapse').off('change').on('change', function () {
            activeSettings.autoCollapse = $(this).prop('checked');
            const block = $('#st_floor_auto_n_block');
            if (activeSettings.autoCollapse) {
                block.css({ opacity: '1', 'pointer-events': 'auto' });
            } else {
                block.css({ opacity: '0.4', 'pointer-events': 'none' });
            }
            persistSettings(false);
            // 勾选或取消勾选时，立即强制重算历史长楼层并即刻生效！
            refreshAllCollapses(true);
        });

        // 5. 倒数 N 楼输入框（修改数值时立即强制重算生效）
        $('#st_floor_auto_n').off('input change').on('input change', function () {
            let n = parseInt($(this).val(), 10);
            if (isNaN(n) || n < 1) n = 1;
            activeSettings.autoCollapseFromN = n;
            persistSettings(false);
            refreshAllCollapses(true);
        });

        // 6. 悬浮跳转按钮开关
        $('#st_floor_enable_jump').off('change').on('change', function () {
            activeSettings.enableJump = $(this).prop('checked');
            persistSettings(false);
            injectFloatingNavButton();
        });

        // 7. 预览字数滑块
        $('#st_floor_preview_len').off('input change').on('input change', function () {
            const val = Number($(this).val()) || 20;
            $('#st_floor_preview_len_value').text(`${val}字`);
            activeSettings.previewLength = val;
            persistSettings(false);
            if (isPanelOpen) renderFloorList();
        });

        // 8. 标签检查开关
        $('#st_floor_enable_tag_check').off('change').on('change', function () {
            activeSettings.enableTagCheck = $(this).prop('checked');
            const tagSubgroup = $('#st_floor_tag_check_subgroup');
            if (activeSettings.enableTagCheck) {
                tagSubgroup.css({ opacity: '1', 'pointer-events': 'auto' });
            } else {
                tagSubgroup.css({ opacity: '0.4', 'pointer-events': 'none' });
            }
            persistSettings(false);
            refreshAllCollapses(true);
            if (isPanelOpen) renderFloorList();
        });

        // 9. 检查标签列表输入框
        $('#st_floor_check_tags').off('input change').on('input change', function () {
            activeSettings.checkTags = $(this).val();
            persistSettings(false);
            refreshAllCollapses(true);
            if (isPanelOpen) renderFloorList();
        });

        // 10. 检查模式切换
        $('#st_floor_tag_check_mode').off('change').on('change', function () {
            activeSettings.tagCheckMode = $(this).val();
            persistSettings(false);
            refreshAllCollapses(true);
            if (isPanelOpen) renderFloorList();
        });

        // 11. 仅检查 AI 消息开关
        $('#st_floor_tag_check_only_ai').off('change').on('change', function () {
            activeSettings.tagCheckOnlyAi = $(this).prop('checked');
            persistSettings(false);
            refreshAllCollapses(true);
            if (isPanelOpen) renderFloorList();
        });

        // 12. 显式保存按钮（给用户百分之百的掌控感与即刻确认）
        $('#st_floor_save_btn').off('click').on('click', function (e) {
            e.stopPropagation();
            persistSettings(true);
            refreshAllCollapses(true);
            if (window.toastr) {
                window.toastr.success('楼层导航与收起配置已保存并立即生效！');
            }
        });

    } catch (err) {
        console.error(`[${EXTENSION_NAME}] 加载 settings.html 失败:`, err);
    }
}

/**
 * 监听 SillyTavern 事件钩子
 */
function setupEventHooks() {
    const context = getStContext();
    const eventSource = context.eventSource;
    const event_types = context.event_types;

    if (!eventSource || !event_types) return;

    // 当服务端扩展设置加载完毕时，与本地设置合并并更新 UI
    const onSettingsLoaded = () => {
        getSettings();
        syncSettingsToUI();
        refreshAllCollapses(true);
    };

    if (event_types.EXTENSION_SETTINGS_LOADED) {
        eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, onSettingsLoaded);
    }
    if (event_types.SETTINGS_LOADED) {
        eventSource.on(event_types.SETTINGS_LOADED, onSettingsLoaded);
    }

    // 监控生成开始与结束状态
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            isGenerating = true;
        });
    }

    const endGenerationEvents = [
        event_types.GENERATION_STOPPED,
        event_types.GENERATION_ENDED,
    ];
    endGenerationEvents.forEach(evt => {
        if (evt) {
            eventSource.on(evt, () => {
                isGenerating = false;
                setTimeout(() => {
                    // 生成结束后，原本的倒数第1楼变成了倒数第2楼，触发自动收起检查
                    refreshAllCollapses(false);
                    if (isPanelOpen) renderFloorList();
                }, 200);
            });
        }
    });

    // 切换聊天事件：重新全量扫描
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(() => {
                refreshAllCollapses(true);
                if (isPanelOpen) renderFloorList();
            }, 250);
        });
    }

    // 消息渲染事件
    const renderEvents = [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_SWIPED,
    ];

    renderEvents.forEach(eventType => {
        if (eventType) {
            eventSource.on(eventType, () => {
                setTimeout(() => {
                    refreshAllCollapses(false);
                    if (isPanelOpen) renderFloorList();
                }, 120);
            });
        }
    });
}

// ==========================================================================
// 插件初始化入口 (jQuery Ready)
// ==========================================================================
jQuery(async () => {
    console.log(`[${EXTENSION_NAME}] 正在初始化楼层导航与收起插件...`);

    // 1. 初始化设置配置（优先从 localStorage 读取，秒级恢复）并应用 CSS 变量
    getSettings();
    applyGlobalCollapseHeight(activeSettings.collapseHeight);

    // 2. 注入扩展可视化设置面板并绑定事件
    await setupSettings();

    // 3. 注入输入区悬浮跳转按钮
    injectFloatingNavButton();

    // 4. 监听外部点击自动收起面板
    setupOutsideClickListener();

    // 5. 设置针对新增消息与图片的监听
    setupObservers();

    // 6. 注册核心事件钩子（包含 SETTINGS_LOADED 监听）
    setupEventHooks();

    // 7. 初次加载对已有楼层进行全量扫描
    setTimeout(() => {
        refreshAllCollapses(true);
    }, 300);

    console.log(`[${EXTENSION_NAME}] 初始化成功！`);
});
