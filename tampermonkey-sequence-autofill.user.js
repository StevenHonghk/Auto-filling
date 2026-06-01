// ==UserScript==
// @name         Safe Sequence Autofill
// @namespace    local.edge.autofill.safe
// @version      0.2.7
// @description  Paste values line by line and fill empty form fields in order. Manual trigger only; never submits forms.
// @author       local
// @match        http://*/*
// @match        https://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.openai.com
// @connect      ark.cn-beijing.volces.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'safeSequenceAutofillValues';
  const AI_PROVIDER_STORAGE_KEY = 'safeSequenceAutofillAiProvider';
  const OPENAI_API_KEY_STORAGE_KEY = 'safeSequenceAutofillOpenAiApiKey';
  const OPENAI_MODEL_STORAGE_KEY = 'safeSequenceAutofillOpenAiModel';
  const DOUBAO_API_KEY_STORAGE_KEY = 'safeSequenceAutofillDoubaoApiKey';
  const DOUBAO_MODEL_STORAGE_KEY = 'safeSequenceAutofillDoubaoModel';
  const COMPATIBLE_API_KEY_STORAGE_KEY = 'safeSequenceAutofillCompatibleApiKey';
  const COMPATIBLE_MODEL_STORAGE_KEY = 'safeSequenceAutofillCompatibleModel';
  const COMPATIBLE_ENDPOINT_STORAGE_KEY = 'safeSequenceAutofillCompatibleEndpoint';
  const AI_SOURCE_STORAGE_KEY = 'safeSequenceAutofillAiSource';
  const DEFAULT_AI_PROVIDER = 'openai';
  const DEFAULT_AI_MODEL = 'gpt-5.4-mini';
  const DEFAULT_DOUBAO_MODEL = 'doubao-seed-2-0-lite-260215';
  const DEFAULT_COMPATIBLE_MODEL = 'deepseek-chat';
  const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
  const DOUBAO_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
  const AI_PROVIDER_PROFILES = {
    openai: {
      label: 'OpenAI',
      transport: 'responses',
      endpoint: OPENAI_API_URL,
      defaultModel: DEFAULT_AI_MODEL,
      apiKeyStorageKey: OPENAI_API_KEY_STORAGE_KEY,
      modelStorageKey: OPENAI_MODEL_STORAGE_KEY,
      keyPlaceholder: 'OpenAI API Key'
    },
    doubao: {
      label: '豆包 / 火山方舟',
      transport: 'chat',
      endpoint: DOUBAO_API_URL,
      defaultModel: DEFAULT_DOUBAO_MODEL,
      apiKeyStorageKey: DOUBAO_API_KEY_STORAGE_KEY,
      modelStorageKey: DOUBAO_MODEL_STORAGE_KEY,
      keyPlaceholder: '火山方舟 ARK API Key',
      bodyExtra: {
        thinking: { type: 'disabled' }
      }
    },
    compatible: {
      label: '自定义 OpenAI 兼容',
      transport: 'chat',
      endpoint: '',
      defaultModel: DEFAULT_COMPATIBLE_MODEL,
      apiKeyStorageKey: COMPATIBLE_API_KEY_STORAGE_KEY,
      modelStorageKey: COMPATIBLE_MODEL_STORAGE_KEY,
      endpointStorageKey: COMPATIBLE_ENDPOINT_STORAGE_KEY,
      keyPlaceholder: 'API Key'
    }
  };
  const PANEL_ID = 'safe-sequence-autofill-panel';
  const BUTTON_ID = 'safe-sequence-autofill-button';
  const BRIDGE_SOURCE = 'safe-sequence-autofill-bridge';
  const BRIDGE_TIMEOUT_MS = 5000;
  const BLOCKED_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'password',
    'radio',
    'range',
    'reset',
    'submit'
  ]);
  let activePanelRefresh = null;
  let liveRefreshTimer = null;
  let liveDetectionObserver = null;
  let bridgeControllerInstalled = false;
  let bridgeWorkerInstalled = false;
  let bridgeRequestId = 0;
  const pendingBridgeRequests = new Map();

  function parseValuesText(text) {
    return String(text || '')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && rect.width > 0
      && rect.height > 0;
  }

  function isOwnUiElement(element) {
    return Boolean(element.closest(`#${PANEL_ID}, #${BUTTON_ID}`));
  }

  function isTopFrame() {
    return window.top === window.self;
  }

  function isHomeworkFrameUrl(url) {
    return /(?:\/mooc-ans\/work\/doHomeWorkNew|doHomeWorkNew|\/mooc2\/work\/dowork|\/api\/work(?:[/?#]|$)|\/mooc-ans\/knowledge\/cards|\/ananas\/modules\/work\/)/.test(String(url || ''));
  }

  function isChaoxingPage() {
    const location = window.location || {};
    const hostname = String(location.hostname || '');
    const href = String(location.href || '');

    return /(?:^|\.)chaoxing\.com$/i.test(hostname)
      || /(?:^|\.)fanya\.chaoxing\.com$/i.test(hostname)
      || /chaoxing\.com/i.test(href);
  }

  function getAnswerEditorCount() {
    return document.querySelectorAll('textarea[id^="answerEditor"], textarea[name^="answerEditor"]').length;
  }

  function hasHomeworkFrame() {
    return [...document.querySelectorAll('iframe')]
      .some((frame) => isHomeworkFrameUrl(frame.src || '') || frameHasAnswerEditors(frame));
  }

  function frameHasAnswerEditors(frame) {
    try {
      return Boolean(frame.contentDocument && frame.contentDocument.querySelector('textarea[id^="answerEditor"], textarea[name^="answerEditor"]'));
    } catch {
      return false;
    }
  }

  function shouldStartAutofill() {
    return getAutofillFrameMode() !== 'off';
  }

  function getAutofillFrameMode() {
    if (isTopFrame()) {
      if (hasHomeworkFrame() && getAnswerEditorCount() === 0 && !isHomeworkFrameUrl(window.location.href)) {
        return 'controller';
      }

      return 'local';
    }

    return 'worker';
  }

  function getElementValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }

    if (element.isContentEditable) {
      return element.textContent || '';
    }

    return '';
  }

  function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  function findUeditor(textarea) {
    const pageWindow = getPageWindow();
    const editorId = textarea.id || textarea.getAttribute('name');

    if (!editorId || !pageWindow.UE || typeof pageWindow.UE.getEditor !== 'function') {
      return null;
    }

    try {
      const editor = pageWindow.UE.getEditor(editorId);
      return editor && typeof editor.setContent === 'function' ? editor : null;
    } catch {
      return null;
    }
  }

  function getUeditorValue(editor) {
    try {
      if (typeof editor.getContentTxt === 'function') {
        return editor.getContentTxt();
      }

      if (typeof editor.getContent === 'function') {
        return editor.getContent().replace(/<[^>]*>/g, '');
      }
    } catch {
      return '';
    }

    return '';
  }

  function isSafeEmptyControl(element) {
    if (element.disabled || element.readOnly || !isVisible(element)) {
      return false;
    }

    if (getElementValue(element).trim().length > 0) {
      return false;
    }

    if (element instanceof HTMLInputElement) {
      return !BLOCKED_INPUT_TYPES.has(element.type.toLowerCase());
    }

    return element instanceof HTMLTextAreaElement || element.isContentEditable;
  }

  function readLabel(element, index) {
    if (element.labels && element.labels.length > 0) {
      const label = Array.from(element.labels)
        .map((item) => (item.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' / ');

      if (label) {
        return label;
      }
    }

    return element.getAttribute('aria-label')
      || element.getAttribute('placeholder')
      || element.getAttribute('name')
      || element.id
      || `field ${index + 1}`;
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function nearbyLabelText(element) {
    const parts = [];
    const previous = element.previousElementSibling;

    if (previous) {
      parts.push(compactText(previous.textContent));
    }

    if (element.parentElement) {
      const text = compactText(element.parentElement.textContent);
      const match = text.match(/第\s*\d+\s*空\s*[:：]?/);
      if (match) {
        parts.push(match[0]);
      }
    }

    return parts.filter(Boolean).join(' ');
  }

  function readControlLabel(element, index) {
    const nearby = nearbyLabelText(element);
    if (/第\s*\d+\s*空/.test(nearby)) {
      return nearby;
    }

    return readLabel(element, index);
  }

  function getBlankNumber(label) {
    const match = String(label || '').match(/第\s*(\d+)\s*空/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function isAnswerContainerId(id) {
    return /^inpDiv/i.test(String(id || ''));
  }

  function getAnswerContainerId(element) {
    const container = typeof element.closest === 'function'
      ? element.closest('[id^="inpDiv"], [id^="inpdiv"]')
      : null;

    if (container) {
      return container.id;
    }

    const getAttr = (name) => (
      typeof element.getAttribute === 'function' ? element.getAttribute(name) || '' : ''
    );
    const names = [element.id, element.name, getAttr('name')];

    for (const value of names) {
      const match = String(value || '').match(/^answerEditor(.+)$/i);
      if (!match || !match[1]) {
        continue;
      }

      const suffix = match[1];
      const fallback = document.getElementById(`inpDiv${suffix}`) || document.getElementById(`inpdiv${suffix}`);
      if (fallback) {
        return fallback.id;
      }
    }

    return '';
  }

  function isExcludedPageControl(element) {
    if (!element || isOwnUiElement(element)) {
      return true;
    }

    const getAttr = (name) => (
      typeof element.getAttribute === 'function' ? element.getAttribute(name) || '' : ''
    );
    const identity = [
      element.id,
      element.name,
      element.className,
      getAttr('placeholder'),
      getAttr('aria-label'),
      getAttr('type')
    ].join(' ').toLowerCase();
    const answerIdentity = /answer|answereditor|inpdiv|blank|填空/.test(identity);

    if (!answerIdentity && /(search|chapterlist|keyword|comment|discuss|topic|note|captcha|validate|verify|upload|file|phone|email|login|password)/.test(identity)) {
      return true;
    }

    return Boolean(element.closest('.discusBg, .note, .newTopic1, .formTopic, .comment, .topic, .search, #selector, #validate, #chapterVerificationCode, .maskDivReport'));
  }

  function getQuestionContainer(element) {
    return element.closest('.TiMu, .questionLi, .blankItemDiv, .readComprehensionQues, .question, .work, [id^="inpDiv"], [id^="inpdiv"]');
  }

  function isAnswerLikeControl(element) {
    if (!element || isExcludedPageControl(element)) {
      return false;
    }

    const getAttr = (name) => (
      typeof element.getAttribute === 'function' ? element.getAttribute(name) || '' : ''
    );
    const id = String(element.id || '');
    const name = String(element.name || getAttr('name') || '');

    if (/^answerEditor/i.test(id) || /^answerEditor/i.test(name)) {
      return true;
    }

    if (isAnswerContainerId(getAnswerContainerId(element))) {
      return true;
    }

    const questionContainer = getQuestionContainer(element);
    if (!questionContainer) {
      return false;
    }

    const parentText = element.parentElement
      ? element.parentElement.innerText || element.parentElement.textContent || ''
      : '';
    const questionText = questionContainer.innerText || questionContainer.textContent || '';
    const labelText = readControlLabel(element, 0);
    const text = compactText(`${questionText} ${parentText} ${labelText}`);

    return /第\s*\d+\s*空|填空题|填空|\bblank\b|\banswer\b/i.test(text);
  }

  function sortControlsByDomOrder(controls) {
    return [...controls].sort((a, b) => {
      const first = a.element || a;
      const second = b.element || b;

      if (!first || !second || first === second || typeof first.compareDocumentPosition !== 'function') {
        return 0;
      }

      return first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function preferAnswerContainerControls(controls) {
    const answerControls = controls.filter((control) => isAnswerContainerId(control.containerId));
    return answerControls.length > 0 ? answerControls : controls;
  }

  function normalizeAiValuesResponse(payload) {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const values = Array.isArray(parsed) ? parsed : parsed && parsed.values;

    if (!Array.isArray(values)) {
      throw new Error('AI 返回格式不正确：缺少 values 数组');
    }

    return values
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0);
  }

  function extractOpenAiResponseText(response) {
    if (typeof response.output_text === 'string') {
      return response.output_text;
    }

    for (const item of response.output || []) {
      for (const content of item.content || []) {
        if (typeof content.text === 'string') {
          return content.text;
        }
      }
    }

    throw new Error('AI 响应里没有可用文本');
  }

  function extractChatCompletionResponseText(response) {
    const text = response && response.choices && response.choices[0]
      && response.choices[0].message && response.choices[0].message.content;

    if (typeof text === 'string') {
      return text;
    }

    throw new Error('AI 响应里没有可用文本');
  }

  function buildAiSystemPrompt() {
    return [
      '你是安全的表单内容整理助手。',
      '只从用户提供的原始资料中提取、拆分已经存在的信息，并按字段顺序输出。',
      '不要根据网页题目推理答案，不要编造，不要自动提交。',
      '如果无法确定某一项，就不要输出占位内容。'
    ].join('\n');
  }

  function buildAiUserPrompt(rawText, controls) {
    const labels = controls
      .map((control, index) => `${index + 1}. ${control.label || `field ${index + 1}`}`)
      .join('\n');

    return [
      '字段顺序:',
      labels || '(未检测到字段标签)',
      '',
      '原始资料:',
      String(rawText || '')
    ].join('\n');
  }

  function buildAiAutofillRequest(provider, model, rawText, controls) {
    const systemPrompt = buildAiSystemPrompt();
    const userPrompt = buildAiUserPrompt(rawText, controls);
    const profile = AI_PROVIDER_PROFILES[provider] || AI_PROVIDER_PROFILES[DEFAULT_AI_PROVIDER];

    if (profile.transport === 'chat') {
      const request = {
        model: model || profile.defaultModel,
        messages: [
          { role: 'system', content: `${systemPrompt}\n只返回 JSON，格式为 {"values":["..."]}。` },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      };

      return {
        ...request,
        ...(profile.bodyExtra || {})
      };
    }

    return {
      model: model || profile.defaultModel,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: systemPrompt
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: userPrompt
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'autofill_values',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              values: {
                type: 'array',
                items: { type: 'string' }
              }
            },
            required: ['values']
          },
          strict: true
        }
      }
    };
  }

  function resolveAiEndpoint(provider, customEndpoint) {
    const profile = AI_PROVIDER_PROFILES[provider] || AI_PROVIDER_PROFILES[DEFAULT_AI_PROVIDER];
    const endpoint = provider === 'compatible' ? String(customEndpoint || '').trim() : profile.endpoint;

    if (!endpoint) {
      throw new Error('请先填写兼容接口地址。');
    }

    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('AI 接口地址不是有效 URL。');
    }

    if (url.protocol !== 'https:') {
      throw new Error('AI 接口地址必须使用 HTTPS。');
    }

    return url.href;
  }

  function requestAiValues(provider, apiKey, model, customEndpoint, rawText, controls) {
    const profile = AI_PROVIDER_PROFILES[provider] || AI_PROVIDER_PROFILES[DEFAULT_AI_PROVIDER];
    const endpoint = resolveAiEndpoint(provider, customEndpoint);

    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('Tampermonkey 未开放 GM_xmlhttpRequest 权限'));
        return;
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: endpoint,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        data: JSON.stringify(buildAiAutofillRequest(provider, model, rawText, controls)),
        timeout: 60000,
        onload(response) {
          let body;
          try {
            body = JSON.parse(response.responseText || '{}');
          } catch {
            reject(new Error('AI 响应不是有效 JSON'));
            return;
          }

          if (response.status < 200 || response.status >= 300) {
            reject(new Error(body.error && body.error.message ? body.error.message : `AI 请求失败：HTTP ${response.status}`));
            return;
          }

          try {
            const outputText = profile.transport === 'chat'
              ? extractChatCompletionResponseText(body)
              : extractOpenAiResponseText(body);
            resolve(normalizeAiValuesResponse(outputText));
          } catch (error) {
            reject(error);
          }
        },
        onerror() {
          reject(new Error('AI 请求失败，请检查网络或 API Key'));
        },
        ontimeout() {
          reject(new Error('AI 请求超时'));
        }
      });
    });
  }

  function formatDetectionStatus(controlCount, valueCount) {
    return `实时检测：可填空格 ${controlCount} 个，内容 ${valueCount} 行。`;
  }

  function formatFloatingButtonText(controlCount) {
    return controlCount > 0 ? `填空(${controlCount})` : '填空';
  }

  function preferNumberedBlankControls(controls) {
    const numbered = controls
      .map((control, index) => ({
        control,
        index,
        blankNumber: getBlankNumber(control.label)
      }))
      .filter((item) => Number.isInteger(item.blankNumber));

    if (numbered.length === 0) {
      return controls;
    }

    return numbered
      .sort((a, b) => a.blankNumber - b.blankNumber || a.index - b.index)
      .map((item) => item.control);
  }

  function isAnswerEditorTextarea(element) {
    return element instanceof HTMLTextAreaElement
      && (/^answerEditor/.test(element.id || '') || /^answerEditor/.test(element.getAttribute('name') || ''));
  }

  function getAnswerEditorTextareas() {
    return [...document.querySelectorAll('textarea[id^="answerEditor"], textarea[name^="answerEditor"]')]
      .filter((textarea) => !isOwnUiElement(textarea))
      .sort((a, b) => (
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      ));
  }

  function createTextareaControl(textarea, index, isAnswerEditor) {
    const editor = findUeditor(textarea);

    if (editor) {
      if (getUeditorValue(editor).trim().length > 0) {
        return null;
      }

      return {
        element: textarea,
        editor,
        kind: 'ueditor',
        label: isAnswerEditor ? `第${index + 1}空` : readControlLabel(textarea, index),
        containerId: getAnswerContainerId(textarea),
        isAnswerEditor
      };
    }

    if (!isSafeEmptyControl(textarea)) {
      return null;
    }

    return {
      element: textarea,
      kind: 'native',
      label: isAnswerEditor ? `第${index + 1}空` : readControlLabel(textarea, index),
      containerId: getAnswerContainerId(textarea),
      isAnswerEditor
    };
  }

  function createNativeControl(element, index) {
    return {
      element,
      kind: 'native',
      label: readControlLabel(element, index),
      containerId: getAnswerContainerId(element)
    };
  }

  function discoverControls() {
    const genericControls = [];
    const structuredControls = [];
    const answerEditorControls = getAnswerEditorTextareas()
      .map((textarea, index) => createTextareaControl(textarea, index, true))
      .filter(Boolean);

    if (answerEditorControls.length > 0) {
      return answerEditorControls;
    }

    for (const textarea of document.querySelectorAll('textarea')) {
      if (isOwnUiElement(textarea) || isAnswerEditorTextarea(textarea) || isExcludedPageControl(textarea)) {
        continue;
      }

      const control = createTextareaControl(textarea, genericControls.length, false);
      if (control) {
        genericControls.push(control);

        if (isAnswerLikeControl(textarea)) {
          structuredControls.push(control);
        }
      }
    }

    const seen = new Set(genericControls.map((control) => control.element));

    for (const element of document.querySelectorAll('input, textarea, [contenteditable="true"]')) {
      if (seen.has(element) || isExcludedPageControl(element) || !isSafeEmptyControl(element)) {
        continue;
      }

      const control = createNativeControl(element, genericControls.length);
      genericControls.push(control);

      if (isAnswerLikeControl(element)) {
        structuredControls.push(control);
      }
    }

    if (structuredControls.length > 0) {
      return preferNumberedBlankControls(preferAnswerContainerControls(sortControlsByDomOrder(structuredControls)));
    }

    return isChaoxingPage() ? [] : sortControlsByDomOrder(genericControls);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function syncUeditorIframeBody(control, textValue) {
    if (!control || !control.containerId || typeof document === 'undefined' || typeof document.getElementById !== 'function') {
      return;
    }

    const container = document.getElementById(control.containerId);
    const iframe = container && typeof container.querySelector === 'function'
      ? container.querySelector('iframe[id^="ueditor_"], iframe')
      : null;

    if (!iframe) {
      return;
    }

    let body = null;
    try {
      body = iframe.contentDocument && iframe.contentDocument.body
        ? iframe.contentDocument.body
        : iframe.contentWindow && iframe.contentWindow.document && iframe.contentWindow.document.body;
    } catch {
      body = null;
    }

    if (!body) {
      return;
    }

    body.innerHTML = `<p>${escapeHtml(textValue)}<br></p>`;

    if (typeof body.dispatchEvent !== 'function') {
      return;
    }

    try {
      body.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: textValue
      }));
    } catch {
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }

    body.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function syncAnswerContainerDisplay(control, textValue) {
    if (!control || !control.containerId || typeof document === 'undefined' || typeof document.getElementById !== 'function') {
      return;
    }

    const container = document.getElementById(control.containerId);
    if (!container) {
      return;
    }

    const target = typeof container.querySelector === 'function'
      ? container.querySelector('[contenteditable="true"], .edui-body-container, .view, textarea, input')
      : null;
    const displayElement = target || container;

    if (displayElement instanceof HTMLInputElement || displayElement instanceof HTMLTextAreaElement) {
      displayElement.value = textValue;

      if (typeof displayElement.setAttribute === 'function') {
        displayElement.setAttribute('value', textValue);
      }
    } else {
      displayElement.textContent = textValue;
    }

    if (typeof displayElement.dispatchEvent !== 'function') {
      return;
    }

    try {
      displayElement.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: textValue
      }));
    } catch {
      displayElement.dispatchEvent(new Event('input', { bubbles: true }));
    }

    displayElement.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setControlValue(control, value) {
    const element = control.element;
    const textValue = String(value);

    if (control.kind === 'ueditor' && control.editor) {
      const notifyTextarea = () => {
        if (typeof element.dispatchEvent !== 'function') {
          return;
        }

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));

        if (typeof element.blur === 'function') {
          element.blur();
        }
      };
      const setEditorContent = () => {
        control.editor.setContent(textValue);

        if (typeof control.editor.sync === 'function') {
          control.editor.sync();
        }

        element.value = textValue;
        if (typeof element.setAttribute === 'function') {
          element.setAttribute('value', textValue);
        }

        if (typeof control.editor.fireEvent === 'function') {
          control.editor.fireEvent('contentChange');
          control.editor.fireEvent('contentchange');
        }

        syncUeditorIframeBody(control, textValue);
        syncAnswerContainerDisplay(control, textValue);
        notifyTextarea();
      };

      if (typeof control.editor.ready === 'function') {
        control.editor.ready(setEditorContent);
      } else {
        setEditorContent();
      }
      return;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();

      if (typeof element.click === 'function') {
        element.click();
      }

      if (typeof element.select === 'function') {
        element.select();
      }

      try {
        element.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: textValue
        }));
      } catch {
        element.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true }));
      }

      const valueDescriptor = Object.getOwnPropertyDescriptor(
        element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      );

      if (valueDescriptor && typeof valueDescriptor.set === 'function') {
        valueDescriptor.set.call(element, textValue);
      } else {
        element.value = textValue;
      }

      if (typeof element.setAttribute === 'function') {
        element.setAttribute('value', textValue);
      }

      syncAnswerContainerDisplay(control, textValue);
      element.dispatchEvent(new Event('input', { bubbles: true }));

      try {
        element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      } catch {
        element.dispatchEvent(new Event('keyup', { bubbles: true }));
      }

      element.dispatchEvent(new Event('change', { bubbles: true }));

      if (typeof element.blur === 'function') {
        element.blur();
      }
      return;
    }

    if (element.isContentEditable) {
      element.focus();
      element.textContent = textValue;
      syncAnswerContainerDisplay(control, textValue);
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: textValue
      }));

      element.dispatchEvent(new Event('change', { bubbles: true }));

      if (typeof element.blur === 'function') {
        element.blur();
      }
    }
  }

  function planSequentialFill(controls, values) {
    const answerEditorControls = controls.filter((control) => control.isAnswerEditor);
    const preferredControls = answerEditorControls.length > 0
      ? answerEditorControls
      : preferNumberedBlankControls(preferAnswerContainerControls(controls));
    const count = Math.min(preferredControls.length, values.length);
    const assignments = [];

    for (let index = 0; index < count; index += 1) {
      assignments.push({
        control: preferredControls[index],
        value: values[index]
      });
    }

    return {
      assignments,
      remainingControls: preferredControls.slice(count),
      unusedValues: values.slice(count)
    };
  }

  function fillCurrentPage(values) {
    const controls = discoverControls();
    const plan = planSequentialFill(controls, values);

    for (const assignment of plan.assignments) {
      setControlValue(assignment.control, assignment.value);
    }

    return {
      filled: plan.assignments.length,
      remainingControls: plan.remainingControls.length,
      unusedValues: plan.unusedValues.length,
      labels: plan.assignments.map((assignment) => assignment.control.label)
    };
  }

  function summarizeCurrentPageControls() {
    const controls = discoverControls();
    return {
      controlCount: controls.length,
      labels: controls.slice(0, 20).map((control) => control.label)
    };
  }

  function getHomeworkFrames() {
    return [...document.querySelectorAll('iframe')]
      .filter((frame) => isHomeworkFrameUrl(frame.src || ''));
  }

  function handleBridgeReply(event) {
    const message = event.data;
    if (!message || message.source !== BRIDGE_SOURCE || message.direction !== 'reply') {
      return;
    }

    const pending = pendingBridgeRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    window.clearTimeout(pending.timer);
    pendingBridgeRequests.delete(message.requestId);

    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }

    pending.resolve(message.payload);
  }

  function installBridgeController() {
    if (bridgeControllerInstalled) {
      return;
    }

    bridgeControllerInstalled = true;
    window.addEventListener('message', handleBridgeReply);
  }

  function requestHomeworkFrame(type, payload) {
    installBridgeController();

    const frames = getHomeworkFrames();
    if (frames.length === 0) {
      return Promise.reject(new Error('没有找到课程题目 iframe。'));
    }

    const requestId = `safe-sequence-${Date.now()}-${bridgeRequestId += 1}`;
    const message = {
      source: BRIDGE_SOURCE,
      direction: 'request',
      type,
      requestId,
      payload: payload || {}
    };

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingBridgeRequests.delete(requestId);
        reject(new Error('作业 iframe 没有响应，请确认 Tampermonkey 允许在 iframe 中运行。'));
      }, BRIDGE_TIMEOUT_MS);

      pendingBridgeRequests.set(requestId, { resolve, reject, timer });

      for (const frame of frames) {
        try {
          frame.contentWindow.postMessage(message, '*');
        } catch {
          // Keep sending to other candidate frames.
        }
      }
    });
  }

  function installBridgeWorker() {
    if (bridgeWorkerInstalled) {
      return;
    }

    bridgeWorkerInstalled = true;
    window.addEventListener('message', async (event) => {
      const message = event.data;
      if (!message || message.source !== BRIDGE_SOURCE || message.direction !== 'request') {
        return;
      }

      const reply = (payload, error) => {
        if (event.source && typeof event.source.postMessage === 'function') {
          event.source.postMessage({
            source: BRIDGE_SOURCE,
            direction: 'reply',
            requestId: message.requestId,
            payload,
            error: error ? String(error.message || error) : ''
          }, '*');
        }
      };

      try {
        if (message.type === 'detect') {
          reply(hasHomeworkFrame() ? await requestHomeworkFrame('detect') : summarizeCurrentPageControls());
          return;
        }

        if (message.type === 'fill') {
          reply(hasHomeworkFrame() ? await requestHomeworkFrame('fill', message.payload) : fillCurrentPage(message.payload && message.payload.values ? message.payload.values : []));
          return;
        }
      } catch (error) {
        reply(null, error);
      }
    });
  }

  async function getDetectionSummary() {
    if (getAutofillFrameMode() === 'controller') {
      try {
        return await requestHomeworkFrame('detect');
      } catch (error) {
        return {
          controlCount: 0,
          labels: [],
          error: error && error.message ? error.message : '无法连接作业 iframe。'
        };
      }
    }

    return summarizeCurrentPageControls();
  }

  async function fillDetectedPage(values) {
    if (getAutofillFrameMode() === 'controller') {
      return requestHomeworkFrame('fill', { values });
    }

    return fillCurrentPage(values);
  }

  async function getControlsForAi() {
    if (getAutofillFrameMode() === 'controller') {
      const summary = await getDetectionSummary();
      return (summary.labels || []).map((label) => ({ label }));
    }

    return discoverControls();
  }

  function getStoredValuesText() {
    return GM_getValue(STORAGE_KEY, '');
  }

  function setStoredValuesText(text) {
    GM_setValue(STORAGE_KEY, String(text || ''));
  }

  function getStoredAiProvider() {
    const provider = GM_getValue(AI_PROVIDER_STORAGE_KEY, DEFAULT_AI_PROVIDER);
    return AI_PROVIDER_PROFILES[provider] ? provider : DEFAULT_AI_PROVIDER;
  }

  function setStoredAiProvider(provider) {
    GM_setValue(AI_PROVIDER_STORAGE_KEY, AI_PROVIDER_PROFILES[provider] ? provider : DEFAULT_AI_PROVIDER);
  }

  function getProviderDefaults(provider) {
    return AI_PROVIDER_PROFILES[provider] || AI_PROVIDER_PROFILES[DEFAULT_AI_PROVIDER];
  }

  function getStoredAiApiKey(provider) {
    return GM_getValue(getProviderDefaults(provider).apiKeyStorageKey, '');
  }

  function setStoredAiApiKey(provider, text) {
    GM_setValue(getProviderDefaults(provider).apiKeyStorageKey, String(text || ''));
  }

  function getStoredAiModel(provider) {
    const defaults = getProviderDefaults(provider);
    return GM_getValue(defaults.modelStorageKey, defaults.defaultModel);
  }

  function setStoredAiModel(provider, text) {
    const defaults = getProviderDefaults(provider);
    GM_setValue(defaults.modelStorageKey, String(text || defaults.defaultModel));
  }

  function getStoredAiEndpoint(provider) {
    const defaults = getProviderDefaults(provider);
    if (!defaults.endpointStorageKey) {
      return defaults.endpoint;
    }

    return GM_getValue(defaults.endpointStorageKey, '');
  }

  function setStoredAiEndpoint(provider, text) {
    const defaults = getProviderDefaults(provider);
    if (defaults.endpointStorageKey) {
      GM_setValue(defaults.endpointStorageKey, String(text || ''));
    }
  }

  function getStoredAiSource() {
    return GM_getValue(AI_SOURCE_STORAGE_KEY, '');
  }

  function setStoredAiSource(text) {
    GM_setValue(AI_SOURCE_STORAGE_KEY, String(text || ''));
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'padding:10px 12px',
      'max-width:360px',
      'font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'color:#fff',
      'background:#1f2937',
      'border-radius:6px',
      'box-shadow:0 8px 24px rgba(0,0,0,.24)'
    ].join(';');
    document.documentElement.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function createButton(text, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', onClick);
    button.style.cssText = [
      'border:0',
      'border-radius:5px',
      'padding:6px 9px',
      'font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'cursor:pointer',
      'color:#fff',
      'background:#2563eb'
    ].join(';');
    return button;
  }

  function updateFloatingButton() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }

    if (getAutofillFrameMode() === 'controller') {
      getDetectionSummary().then((summary) => {
        const nextText = formatFloatingButtonText(summary.controlCount || 0);
        if (button.textContent !== nextText) {
          button.textContent = nextText;
        }
      });
      return;
    }

    const nextText = formatFloatingButtonText(discoverControls().length);
    if (button.textContent !== nextText) {
      button.textContent = nextText;
    }
  }

  function refreshLiveDetection() {
    updateFloatingButton();

    if (typeof activePanelRefresh === 'function') {
      activePanelRefresh();
    }
  }

  function scheduleLiveRefresh() {
    window.clearTimeout(liveRefreshTimer);
    liveRefreshTimer = window.setTimeout(refreshLiveDetection, 180);
  }

  function installLiveDetection() {
    if (liveDetectionObserver) {
      return;
    }

    liveDetectionObserver = new MutationObserver(scheduleLiveRefresh);
    liveDetectionObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'disabled', 'readonly', 'aria-hidden']
    });
    document.addEventListener('input', scheduleLiveRefresh, true);
    document.addEventListener('change', scheduleLiveRefresh, true);
  }

  function openPanel() {
    document.getElementById(PANEL_ID)?.remove();

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed',
      'right:16px',
      'top:72px',
      'z-index:2147483647',
      'width:360px',
      'max-width:calc(100vw - 32px)',
      'background:#fff',
      'color:#111827',
      'border:1px solid #d1d5db',
      'border-radius:8px',
      'box-shadow:0 18px 48px rgba(0,0,0,.2)',
      'font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');

    const header = document.createElement('div');
    header.textContent = '顺序填空';
    header.style.cssText = 'padding:10px 12px;font-weight:700;border-bottom:1px solid #e5e7eb;';

    const textarea = document.createElement('textarea');
    textarea.value = getStoredValuesText();
    textarea.placeholder = '一行一个内容，例如：\n张三\n13800000000\nzhangsan@example.com';
    textarea.style.cssText = [
      'box-sizing:border-box',
      'width:calc(100% - 24px)',
      'height:180px',
      'margin:12px',
      'resize:vertical',
      'padding:8px',
      'border:1px solid #d1d5db',
      'border-radius:6px',
      'font:13px/1.45 Consolas,monospace',
      'color:#111827',
      'background:#fff'
    ].join(';');

    const status = document.createElement('div');
    status.style.cssText = 'padding:0 12px 10px;color:#4b5563;';

    const preview = document.createElement('pre');
    preview.style.cssText = [
      'box-sizing:border-box',
      'width:calc(100% - 24px)',
      'max-height:110px',
      'margin:0 12px 12px',
      'overflow:auto',
      'white-space:pre-wrap',
      'padding:8px',
      'border:1px solid #e5e7eb',
      'border-radius:6px',
      'font:12px/1.45 Consolas,monospace',
      'color:#374151',
      'background:#f9fafb'
    ].join(';');

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;padding:0 12px 12px;';

    let refreshStatusId = 0;

    async function refreshStatus() {
      const currentRefreshId = refreshStatusId += 1;
      const values = parseValuesText(textarea.value);
      const summary = await getDetectionSummary();

      if (currentRefreshId !== refreshStatusId) {
        return;
      }

      const labels = summary.labels || [];
      const nextStatus = formatDetectionStatus(summary.controlCount || 0, values.length);
      const nextPreview = summary.error
        ? summary.error
        : labels.length > 0
          ? labels.slice(0, 20).map((label, index) => `${index + 1}. ${label}`).join('\n')
          : '未检测到可填空格';

      if (status.textContent !== nextStatus) {
        status.textContent = nextStatus;
      }

      if (preview.textContent !== nextPreview) {
        preview.textContent = nextPreview;
      }

      updateFloatingButton();
    }

    textarea.addEventListener('input', refreshStatus);

    const saveButton = createButton('保存内容', () => {
      setStoredValuesText(textarea.value);
      refreshStatus();
      showToast('内容已保存到 Tampermonkey 存储。');
    });

    const fillButton = createButton('填入当前页', async () => {
      const values = parseValuesText(textarea.value);
      if (values.length === 0) {
        showToast('没有可填内容，请先粘贴一行一个的内容。');
        return;
      }

      setStoredValuesText(textarea.value);
      fillButton.disabled = true;
      fillButton.textContent = '填入中...';

      try {
        const report = await fillDetectedPage(values);
        refreshStatus();
        showToast(`已填 ${report.filled} 个；剩余空格 ${report.remainingControls} 个；未用内容 ${report.unusedValues} 行。`);
      } catch (error) {
        showToast(error && error.message ? error.message : '填入失败。');
      } finally {
        fillButton.disabled = false;
        fillButton.textContent = '填入当前页';
      }
    });

    const clearButton = createButton('清空保存', () => {
      textarea.value = '';
      setStoredValuesText('');
      refreshStatus();
      showToast('已清空保存内容。');
    });
    clearButton.style.background = '#6b7280';

    const aiBox = document.createElement('details');
    aiBox.style.cssText = 'margin:0 12px 12px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;';

    const aiSummary = document.createElement('summary');
    aiSummary.textContent = 'AI整理';
    aiSummary.style.cssText = 'padding:8px;cursor:pointer;font-weight:600;';

    const aiProviderSelect = document.createElement('select');
    aiProviderSelect.value = getStoredAiProvider();
    aiProviderSelect.style.cssText = 'box-sizing:border-box;width:calc(100% - 16px);margin:0 8px 8px;padding:7px;border:1px solid #d1d5db;border-radius:5px;background:#fff;';

    for (const [providerId, profile] of Object.entries(AI_PROVIDER_PROFILES)) {
      const option = document.createElement('option');
      option.value = providerId;
      option.textContent = profile.label;
      aiProviderSelect.append(option);
    }

    const aiApiKeyInput = document.createElement('input');
    aiApiKeyInput.type = 'password';
    aiApiKeyInput.style.cssText = 'box-sizing:border-box;width:calc(100% - 16px);margin:0 8px 8px;padding:7px;border:1px solid #d1d5db;border-radius:5px;';

    const aiModelInput = document.createElement('input');
    aiModelInput.type = 'text';
    aiModelInput.style.cssText = 'box-sizing:border-box;width:calc(100% - 16px);margin:0 8px 8px;padding:7px;border:1px solid #d1d5db;border-radius:5px;';

    const aiEndpointInput = document.createElement('input');
    aiEndpointInput.type = 'url';
    aiEndpointInput.style.cssText = 'box-sizing:border-box;width:calc(100% - 16px);margin:0 8px 8px;padding:7px;border:1px solid #d1d5db;border-radius:5px;';

    function updateAiProviderUi() {
      const provider = aiProviderSelect.value;
      const defaults = getProviderDefaults(provider);
      aiApiKeyInput.value = getStoredAiApiKey(provider);
      aiApiKeyInput.placeholder = defaults.keyPlaceholder;
      aiModelInput.value = getStoredAiModel(provider);
      aiModelInput.placeholder = defaults.defaultModel;
      aiEndpointInput.value = getStoredAiEndpoint(provider);
      aiEndpointInput.placeholder = provider === 'compatible'
        ? 'https://api.example.com/v1/chat/completions'
        : defaults.endpoint;
      aiEndpointInput.readOnly = provider !== 'compatible';
      aiEndpointInput.style.background = provider === 'compatible' ? '#fff' : '#f3f4f6';
    }

    aiProviderSelect.addEventListener('change', () => {
      setStoredAiProvider(aiProviderSelect.value);
      updateAiProviderUi();
    });
    updateAiProviderUi();

    const aiSourceTextarea = document.createElement('textarea');
    aiSourceTextarea.value = getStoredAiSource();
    aiSourceTextarea.placeholder = '把需要整理的大段内容粘贴到这里';
    aiSourceTextarea.style.cssText = [
      'box-sizing:border-box',
      'width:calc(100% - 16px)',
      'height:96px',
      'margin:0 8px 8px',
      'resize:vertical',
      'padding:7px',
      'border:1px solid #d1d5db',
      'border-radius:5px',
      'font:12px/1.45 Consolas,monospace',
      'background:#fff'
    ].join(';');

    const aiActions = document.createElement('div');
    aiActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;padding:0 8px 8px;';

    const aiSaveButton = createButton('保存AI设置', () => {
      const provider = aiProviderSelect.value;
      setStoredAiProvider(provider);
      setStoredAiApiKey(provider, aiApiKeyInput.value.trim());
      setStoredAiModel(provider, aiModelInput.value.trim());
      setStoredAiEndpoint(provider, aiEndpointInput.value.trim());
      setStoredAiSource(aiSourceTextarea.value);
      showToast('AI 设置已保存。');
    });
    aiSaveButton.style.background = '#6b7280';

    const aiButton = createButton('AI整理为列表', async () => {
      const provider = aiProviderSelect.value;
      const apiKey = aiApiKeyInput.value.trim();
      const endpoint = aiEndpointInput.value.trim();
      const rawText = aiSourceTextarea.value.trim();
      const controls = await getControlsForAi();

      if (!apiKey) {
        showToast(`请先输入${getProviderDefaults(provider).label} API Key。`);
        return;
      }

      if (provider === 'compatible' && !endpoint) {
        showToast('请先填写兼容接口地址。');
        return;
      }

      if (!rawText) {
        showToast('请先粘贴需要整理的原始内容。');
        return;
      }

      if (controls.length === 0) {
        showToast('当前页面没有检测到可填空格。');
        return;
      }

      setStoredAiProvider(provider);
      setStoredAiApiKey(provider, apiKey);
      setStoredAiModel(provider, aiModelInput.value.trim());
      setStoredAiEndpoint(provider, endpoint);
      setStoredAiSource(aiSourceTextarea.value);
      aiButton.disabled = true;
      aiButton.textContent = '整理中...';

      try {
        const values = await requestAiValues(provider, apiKey, aiModelInput.value.trim(), endpoint, rawText, controls);
        textarea.value = values.join('\n');
        setStoredValuesText(textarea.value);
        refreshStatus();
        showToast(`AI 已整理 ${values.length} 行，请检查后再填入。`);
      } catch (error) {
        showToast(error && error.message ? error.message : 'AI 整理失败。');
      } finally {
        aiButton.disabled = false;
        aiButton.textContent = 'AI整理为列表';
      }
    });

    aiActions.append(aiSaveButton, aiButton);
    aiBox.append(aiSummary, aiProviderSelect, aiApiKeyInput, aiModelInput, aiEndpointInput, aiSourceTextarea, aiActions);

    const closeButton = createButton('关闭', () => {
      if (activePanelRefresh === refreshStatus) {
        activePanelRefresh = null;
      }
      panel.remove();
    });
    closeButton.style.background = '#374151';

    actions.append(saveButton, fillButton, clearButton, closeButton);
    panel.append(header, textarea, status, preview, aiBox, actions);
    document.documentElement.appendChild(panel);
    activePanelRefresh = refreshStatus;
    refreshStatus();
    textarea.focus();
  }

  function createFloatingButton() {
    if (document.getElementById(BUTTON_ID)) {
      return;
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = formatFloatingButtonText(discoverControls().length);
    button.addEventListener('click', openPanel);
    button.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483646',
      'border:0',
      'border-radius:8px',
      'padding:8px 10px',
      'font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'cursor:pointer',
      'color:#fff',
      'background:#2563eb',
      'box-shadow:0 8px 24px rgba(0,0,0,.2)'
    ].join(';');
    document.documentElement.appendChild(button);
  }

  function start() {
    const mode = getAutofillFrameMode();

    if (mode === 'off') {
      return;
    }

    if (mode === 'worker') {
      installBridgeWorker();
      return;
    }

    installBridgeController();
    GM_registerMenuCommand('顺序填空：打开面板', openPanel);
    GM_registerMenuCommand('顺序填空：直接填入保存内容', async () => {
      const values = parseValuesText(getStoredValuesText());
      if (values.length === 0) {
        showToast('没有保存内容，请先打开面板粘贴内容。');
        return;
      }

      try {
        const report = await fillDetectedPage(values);
        showToast(`已填 ${report.filled} 个；剩余空格 ${report.remainingControls} 个；未用内容 ${report.unusedValues} 行。`);
      } catch (error) {
        showToast(error && error.message ? error.message : '填入失败。');
      }
    });
    createFloatingButton();
    installLiveDetection();
    scheduleLiveRefresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
