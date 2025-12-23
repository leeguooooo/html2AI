// ==UserScript==
// @name         AI Page Fixer
// @namespace    https://example.com/ai-page-fixer
// @version      0.7.0
// @description  Copy selected page content into an AI-friendly format
// @match        http://*/*
// @match        https://*/*
// @match        file://*/*
// @all-frames   true
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "ai_fix_panel_pos";
  const PANEL_ID = "ai-fix-panel";
  const PICK_MODE_CLASS = "ai-fix-pick-mode";
  const HIGHLIGHT_ID = "ai-fix-highlight";
  const IFRAME_MASK_CLASS = "ai-fix-iframe-mask";
  const DEBUG = false;
  const HEALTH_INTERVAL_MS = 1500;
  const ACTIVE_FLAG = "__AI_FIX_ACTIVE__";
  const DOCK_THRESHOLD = 36;
  const DOCK_TAB_PX = 12;
  const SMART_SELECTOR = [
    "article",
    "main",
    "[role='main']",
    "#content",
    ".content",
    ".post",
    ".article",
    ".entry",
    ".markdown",
    ".md",
    ".post-content",
    ".article-body",
    ".rich-text",
    ".document",
    ".docs",
  ].join(",");
  const MIN_SMART_TEXT = 120;

  const styles = `
    #${PANEL_ID} {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      background: transparent;
      user-select: none;
      width: auto;
      transition: transform 180ms ease;
    }
    #${PANEL_ID} button {
      background: #111;
      border: none;
      border-radius: 999px;
      padding: 8px 14px;
      font: 12px/1.2 "Helvetica Neue", Arial, sans-serif;
      color: #f5f5f5;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }
    #${PANEL_ID}.ai-fix-docked-left {
      left: 0;
      transform: translateX(calc(-100% + var(--ai-fix-tab, 12px)));
    }
    #${PANEL_ID}.ai-fix-docked-right {
      transform: translateX(calc(100% - var(--ai-fix-tab, 12px)));
    }
    #${PANEL_ID}.ai-fix-docked-left:hover,
    #${PANEL_ID}.ai-fix-docked-right:hover {
      transform: translateX(0);
    }
    #${PANEL_ID}.ai-fix-dragging {
      transition: none;
      transform: translateX(0);
    }
    #${PANEL_ID} button:active {
      transform: translateY(1px);
    }
    #${HIGHLIGHT_ID} {
      position: absolute;
      pointer-events: none;
      border: 2px solid #00ffd0;
      background: rgba(0, 255, 208, 0.08);
      z-index: 2147483646;
    }
    .${IFRAME_MASK_CLASS} {
      position: absolute;
      background: transparent;
      z-index: 2147483645;
      cursor: crosshair;
    }
    body.${PICK_MODE_CLASS} * {
      cursor: crosshair !important;
    }
  `;

  function logDebug(...args) {
    if (!DEBUG) return;
    console.debug("[AI FIX]", ...args);
  }

  try {
    window[ACTIVE_FLAG] = true;
  } catch (err) {
    // Ignore global write failures.
  }

  function addStyle(cssText) {
    if (typeof GM_addStyle === "function") {
      GM_addStyle(cssText);
      return;
    }
    const style = document.createElement("style");
    style.textContent = cssText;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBodyReady(callback) {
    if (document.body) {
      callback();
      return;
    }
    const onReady = () => {
      document.removeEventListener("DOMContentLoaded", onReady);
      callback();
    };
    document.addEventListener("DOMContentLoaded", onReady);
  }

  let panel = null;
  let buttons = null;
  let primaryButton = null;
  let globalListenersAttached = false;
  let watchStarted = false;
  let iframeMasks = [];
  let iframeMaskListenersAttached = false;
  let iframeMaskTimer = null;
  let suppressClick = false;
  let dockSide = null;

  let pickMode = false;
  let highlight = null;
  let dragState = null;
  let statusTimer = null;

  function setStatus(text) {
    if (!primaryButton) return;
    primaryButton.title = text || "";
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (text) {
      statusTimer = window.setTimeout(() => {
        if (primaryButton) {
          primaryButton.title = "";
        }
      }, 2500);
    }
  }

  function loadPosition() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const pos = JSON.parse(stored);
      if (typeof pos.top === "number") {
        panel.style.top = `${pos.top}px`;
      }
      if (pos.dock === "left" || pos.dock === "right") {
        applyDock(pos.dock, typeof pos.top === "number" ? pos.top : undefined);
      } else if (typeof pos.left === "number") {
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${typeof pos.top === "number" ? pos.top : 20}px`;
        panel.style.right = "auto";
      }
      clampPanelPosition();
    } catch (err) {
      // Ignore storage errors.
    }
  }

  function savePosition(left, top, dock) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          left: Math.round(left),
          top: Math.round(top),
          dock: dock || null,
        })
      );
    } catch (err) {
      // Ignore storage errors.
    }
  }

  function startDrag(event) {
    if (event.button !== 0) return;
    if (dockSide) {
      clearDock();
    }
    panel.classList.add("ai-fix-dragging");
    const rect = panel.getBoundingClientRect();
    dragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.preventDefault();
  }

  function onDrag(event) {
    if (!dragState) return;
    const deltaX = Math.abs(event.clientX - dragState.startX);
    const deltaY = Math.abs(event.clientY - dragState.startY);
    if (deltaX > 3 || deltaY > 3) {
      dragState.moved = true;
    }
    const left = Math.max(0, event.clientX - dragState.offsetX);
    const top = Math.max(0, event.clientY - dragState.offsetY);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
  }

  function stopDrag(event) {
    if (!dragState) return;
    const rect = panel.getBoundingClientRect();
    if (dragState.moved) {
      suppressClick = true;
      window.setTimeout(() => {
        suppressClick = false;
      }, 0);
    }
    dragState = null;
    panel.classList.remove("ai-fix-dragging");
    snapToEdge(rect);
    clampPanelPosition();
  }

  function snapToEdge(rect) {
    if (!rect) rect = panel.getBoundingClientRect();
    const leftDistance = rect.left;
    const rightDistance = window.innerWidth - rect.right;
    if (leftDistance <= DOCK_THRESHOLD) {
      applyDock("left");
      return;
    }
    if (rightDistance <= DOCK_THRESHOLD) {
      applyDock("right");
      return;
    }
    clearDock();
    savePosition(rect.left, rect.top, null);
  }

  function clearDock() {
    dockSide = null;
    panel.classList.remove("ai-fix-docked-left", "ai-fix-docked-right");
  }

  function applyDock(side, topOverride) {
    if (!panel) return;
    dockSide = side;
    panel.classList.toggle("ai-fix-docked-left", side === "left");
    panel.classList.toggle("ai-fix-docked-right", side === "right");
    panel.style.right = "auto";
    const rect = panel.getBoundingClientRect();
    const top = typeof topOverride === "number" ? topOverride : rect.top;
    const anchorLeft =
      side === "left" ? 0 : Math.max(0, window.innerWidth - rect.width);
    panel.style.left = `${anchorLeft}px`;
    panel.style.top = `${top}px`;
    savePosition(anchorLeft, top, side);
  }

  function clampPanelPosition() {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    let left = rect.left;
    let top = rect.top;
    let clamped = false;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    if (dockSide) {
      if (rect.top < margin) {
        top = margin;
        clamped = true;
      }
      if (rect.bottom > window.innerHeight - margin) {
        top = maxTop;
        clamped = true;
      }
      if (clamped) {
        applyDock(dockSide, top);
      }
      return;
    }
    if (rect.left < margin) {
      left = margin;
      clamped = true;
    }
    if (rect.top < margin) {
      top = margin;
      clamped = true;
    }
    if (rect.right > window.innerWidth - margin) {
      left = maxLeft;
      clamped = true;
    }
    if (rect.bottom > window.innerHeight - margin) {
      top = maxTop;
      clamped = true;
    }
    if (clamped) {
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
      savePosition(left, top, null);
    }
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.setProperty("--ai-fix-tab", `${DOCK_TAB_PX}px`);
    panel.innerHTML = `
      <button type="button" data-action="pick">复制给AI</button>
    `;
    document.body.appendChild(panel);

    buttons = panel.querySelectorAll("button");
    primaryButton = buttons[0] || null;

    panel.addEventListener("mousedown", startDrag);
    if (!globalListenersAttached) {
      window.addEventListener("mousemove", onDrag);
      window.addEventListener("mouseup", stopDrag);
      document.addEventListener("mousemove", onPickMove, true);
      document.addEventListener("click", onPickClick, true);
      window.addEventListener("resize", clampPanelPosition);
      globalListenersAttached = true;
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        if (suppressClick) return;
        const action = button.getAttribute("data-action");
        if (action === "pick") onPick();
      });
    });

    loadPosition();
    clampPanelPosition();
  }

  function startPanelWatch() {
    if (watchStarted) return;
    watchStarted = true;
    window.setInterval(() => {
      if (!document.body) return;
      if (!document.getElementById(PANEL_ID)) {
        mountPanel();
      }
    }, HEALTH_INTERVAL_MS);
  }

  function ensureHighlight() {
    if (highlight) return highlight;
    highlight = document.createElement("div");
    highlight.id = HIGHLIGHT_ID;
    document.body.appendChild(highlight);
    return highlight;
  }

  function updateHighlight(target) {
    const box = target.getBoundingClientRect();
    const highlightEl = ensureHighlight();
    highlightEl.style.left = `${box.left + window.scrollX}px`;
    highlightEl.style.top = `${box.top + window.scrollY}px`;
    highlightEl.style.width = `${box.width}px`;
    highlightEl.style.height = `${box.height}px`;
  }

  function clearHighlight() {
    if (highlight && highlight.parentNode) {
      highlight.parentNode.removeChild(highlight);
    }
    highlight = null;
  }

  function positionIframeMask(mask, iframe) {
    const rect = iframe.getBoundingClientRect();
    mask.style.left = `${rect.left + window.scrollX}px`;
    mask.style.top = `${rect.top + window.scrollY}px`;
    mask.style.width = `${rect.width}px`;
    mask.style.height = `${rect.height}px`;
  }

  function clearIframeMasks() {
    iframeMasks.forEach((mask) => mask.remove());
    iframeMasks = [];
  }

  function updateIframeMasks() {
    iframeMasks.forEach((mask) => {
      const iframe = mask.__aiFixIframe;
      if (!iframe || !iframe.isConnected) {
        mask.remove();
        return;
      }
      positionIframeMask(mask, iframe);
    });
  }

  function ensureIframeMasks() {
    clearIframeMasks();
    const iframes = Array.from(document.querySelectorAll("iframe"));
    iframes.forEach((iframe) => {
      const rect = iframe.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return;
      const mask = document.createElement("div");
      mask.className = IFRAME_MASK_CLASS;
      mask.__aiFixIframe = iframe;
      positionIframeMask(mask, iframe);
      mask.addEventListener("mousemove", () => updateHighlight(iframe));
      mask.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const source = buildSourceFromNode(iframe, "iframe");
        clearTextSelection();
        exitPickMode();
        copyFromSource(source);
      });
      document.body.appendChild(mask);
      iframeMasks.push(mask);
    });
    if (!iframeMaskListenersAttached) {
      window.addEventListener("scroll", updateIframeMasks, true);
      window.addEventListener("resize", updateIframeMasks);
      iframeMaskListenersAttached = true;
    }
    if (iframeMaskTimer) {
      clearInterval(iframeMaskTimer);
    }
    iframeMaskTimer = window.setInterval(updateIframeMasks, 500);
  }

  function disableIframeMasks() {
    clearIframeMasks();
    if (iframeMaskTimer) {
      clearInterval(iframeMaskTimer);
      iframeMaskTimer = null;
    }
  }

  function enterPickMode() {
    pickMode = true;
    document.body.classList.add(PICK_MODE_CLASS);
    setStatus("Click an element to copy.");
    ensureIframeMasks();
  }

  function exitPickMode() {
    pickMode = false;
    document.body.classList.remove(PICK_MODE_CLASS);
    clearHighlight();
    disableIframeMasks();
  }

  function getEventTarget(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const item of path) {
      if (item && item.classList && item.classList.contains(IFRAME_MASK_CLASS)) {
        return item.__aiFixIframe || null;
      }
      if (item && item.nodeType === Node.ELEMENT_NODE && item !== panel && !panel.contains(item)) {
        return item;
      }
    }
    const fallback = event.target;
    if (fallback && fallback.nodeType === Node.ELEMENT_NODE) {
      return fallback;
    }
    return null;
  }

  function getTextLength(node) {
    if (!node) return 0;
    const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    return text.length;
  }

  function isIframeElement(node) {
    return node && node.tagName && node.tagName.toLowerCase() === "iframe";
  }

  function findSmartContainer(target) {
    if (isIframeElement(target)) return target;
    let current = target;
    let best = target;
    let bestLen = getTextLength(target);
    while (current && current !== document.body) {
      if (current.matches && current.matches(SMART_SELECTOR)) {
        return current;
      }
      const len = getTextLength(current);
      if (len >= MIN_SMART_TEXT && len > bestLen) {
        best = current;
        bestLen = len;
      }
      current = current.parentElement;
    }
    return best || target;
  }

  function choosePickTarget(target, event) {
    if (!target) return null;
    if (isIframeElement(target)) return target;
    if (event && event.altKey) return target;
    if (event && event.shiftKey && target.parentElement) return target.parentElement;
    if (getTextLength(target) >= MIN_SMART_TEXT) return target;
    return findSmartContainer(target);
  }

  function clearTextSelection() {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }

  function onPickMove(event) {
    if (!pickMode) return;
    const target = getEventTarget(event);
    if (!target || target === panel || panel.contains(target)) return;
    const previewTarget = choosePickTarget(target, event);
    if (previewTarget) updateHighlight(previewTarget);
  }

  function onPickClick(event) {
    if (!pickMode) return;
    const target = getEventTarget(event);
    if (!target || target === panel || panel.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    const chosen = choosePickTarget(target, event);
    clearTextSelection();
    exitPickMode();
    const source = buildSourceFromNode(chosen, "picked-element");
    copyFromSource(source);
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function normalizeInline(text) {
    return text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function inlineText(node) {
    const parts = [];
    function collectPlainInline(current) {
      const plainParts = [];
      function walkPlain(nodeItem) {
        if (!nodeItem) return;
        if (nodeItem.nodeType === Node.TEXT_NODE) {
          plainParts.push(nodeItem.nodeValue || "");
          return;
        }
        if (nodeItem.nodeType !== Node.ELEMENT_NODE) return;
        const tagName = nodeItem.tagName.toLowerCase();
        if (["script", "style", "noscript"].includes(tagName)) return;
        if (tagName === "br") {
          plainParts.push("\n");
          return;
        }
        if (tagName === "img") {
          const alt = nodeItem.getAttribute("alt") || "";
          const src = nodeItem.getAttribute("src") || "";
          if (src) {
            plainParts.push(`![${alt}](${src})`);
          } else if (alt) {
            plainParts.push(alt);
          }
          return;
        }
        if (tagName === "code") {
          const code = nodeItem.textContent || "";
          if (code.trim()) {
            plainParts.push("`" + code.replace(/`/g, "\\`") + "`");
          }
          return;
        }
        if (tagName === "ul" || tagName === "ol") return;
        const children = Array.from(nodeItem.childNodes);
        children.forEach(walkPlain);
      }
      walkPlain(current);
      return normalizeInline(plainParts.join(""));
    }

    function walk(current) {
      if (!current) return;
      if (current.nodeType === Node.TEXT_NODE) {
        parts.push(current.nodeValue || "");
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE) return;
      const tag = current.tagName.toLowerCase();
      if (["script", "style", "noscript"].includes(tag)) return;
      if (tag === "br") {
        parts.push("\n");
        return;
      }
      if (tag === "a") {
        const text = collectPlainInline(current);
        const href = current.getAttribute("href");
        if (href && text) {
          parts.push(`[${text}](${href})`);
        } else if (text) {
          parts.push(text);
        }
        return;
      }
      if (tag === "img") {
        const alt = current.getAttribute("alt") || "";
        const src = current.getAttribute("src") || "";
        if (src) {
          parts.push(`![${alt}](${src})`);
        } else if (alt) {
          parts.push(alt);
        }
        return;
      }
      if (tag === "code") {
        const code = current.textContent || "";
        if (code.trim()) {
          parts.push("`" + code.replace(/`/g, "\\`") + "`");
        }
        return;
      }
      if (tag === "ul" || tag === "ol") return;
      const children = Array.from(current.childNodes);
      children.forEach(walk);
    }
    walk(node);
    return normalizeInline(parts.join(""));
  }

  function escapeCodeFence(text) {
    return text.replace(/```/g, "``\\`");
  }

  function collectLines(node, lines, context) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = context.inPre ? node.nodeValue : normalizeText(node.nodeValue || "");
      if (value) lines.push(value);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    const isBlock =
      ["p", "div", "section", "article", "aside", "header", "footer", "main"].includes(tag);

    if (tag.match(/^h[1-6]$/)) {
      const level = Number(tag[1]);
      const text = inlineText(node);
      if (text) lines.push(`${"#".repeat(level)} ${text}`);
      lines.push("");
      return;
    }

    if (tag === "p") {
      const text = inlineText(node);
      if (text) lines.push(text);
      lines.push("");
      return;
    }

    if (tag === "br") {
      lines.push("");
      return;
    }

    if (tag === "pre") {
      const code = escapeCodeFence(node.textContent || "");
      lines.push("```");
      lines.push(code.trimEnd());
      lines.push("```");
      lines.push("");
      return;
    }

    if (tag === "code") {
      const code = node.textContent || "";
      if (code.trim()) {
        lines.push("`" + code.replace(/`/g, "\\`") + "`");
      }
      return;
    }

    if (tag === "blockquote") {
      const text = inlineText(node);
      if (text) {
        text.split("\n").forEach((line) => {
          lines.push(`> ${line}`);
        });
        lines.push("");
      }
      return;
    }

    if (tag === "ul" || tag === "ol") {
      const listItems = Array.from(node.querySelectorAll(":scope > li"));
      listItems.forEach((li, index) => {
        const prefix = tag === "ol" ? `${index + 1}.` : "-";
        const text = inlineText(li);
        if (text) lines.push(`${prefix} ${text}`);
        const nestedLists = Array.from(li.children).filter(
          (child) => child.tagName && ["UL", "OL"].includes(child.tagName)
        );
        nestedLists.forEach((nested) => collectLines(nested, lines, context));
      });
      lines.push("");
      return;
    }

    if (tag === "table") {
      const rows = Array.from(node.querySelectorAll("tr"));
      if (rows.length) {
        lines.push("Table:");
        rows.forEach((row) => {
          const cells = Array.from(row.querySelectorAll("th, td")).map((cell) =>
            inlineText(cell)
          );
          if (cells.length) lines.push(cells.join(" | "));
        });
        lines.push("");
      }
      return;
    }

    if (["script", "style", "noscript"].includes(tag)) {
      return;
    }

    const nextContext = { ...context };
    if (tag === "code") nextContext.inPre = true;

    const children = Array.from(node.childNodes);
    children.forEach((child) => collectLines(child, lines, nextContext));

    if (isBlock) lines.push("");
  }

  function getRawTextFromNode(node) {
    if (!node) return "";
    const text = (node.innerText || node.textContent || "").trim();
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  function resolveIframeContent(iframe) {
    if (!iframe) return null;
    let doc = null;
    try {
      doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
    } catch (err) {
      return {
        error: "iframe-cross-origin",
        label: "iframe-cross-origin",
        iframeSrc: iframe.getAttribute("src") || "",
      };
    }
    if (!doc || !doc.body) {
      return {
        error: "iframe-unavailable",
        label: "iframe-unavailable",
        iframeSrc: iframe.getAttribute("src") || "",
      };
    }
    return {
      node: doc.body,
      rawText: getRawTextFromNode(doc.body),
      label: "iframe-content",
    };
  }


  function toAIFormat(source) {
    const header = [
      `Title: ${document.title || "Untitled"}`,
      `URL: ${location.href}`,
      `Source: ${source.label}`,
      `Captured: ${new Date().toISOString()}`,
      "---",
      "",
    ];

    const contentLines = [];
    const context = { inPre: false };
    if (source.node) {
      collectLines(source.node, contentLines, context);
    }

    let content = contentLines
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const rawText = source.rawText || "";
    if (
      rawText &&
      ((rawText.length > 400 && content.length < 200) || content.length < rawText.length * 0.4)
    ) {
      content = rawText.trim();
    }

    return header.join("\n") + content + "\n";
  }

  function selectionToContainer(selection) {
    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();
    const wrapper = document.createElement("div");
    wrapper.appendChild(fragment);
    return wrapper;
  }

  function getSelectionSource() {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      return {
        node: selectionToContainer(selection),
        rawText: selection.toString(),
        label: "text-selection",
      };
    }
    return null;
  }

  function buildSourceFromNode(node, label) {
    if (!node) return null;
    if (isIframeElement(node)) {
      return resolveIframeContent(node) || { label: "picked-iframe" };
    }
    return {
      node,
      rawText: getRawTextFromNode(node),
      label,
    };
  }

  function copyText(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text, { type: "text", mimetype: "text/plain" });
      return Promise.resolve();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    return Promise.resolve();
  }

  function copyFromSource(source) {
    if (!source) return;
    if (source && source.error) {
      if (source.iframeSrc) {
        setStatus("Cross-origin iframe. Enable all-frames in script manager.");
      } else {
        setStatus("Iframe content not accessible.");
      }
      return;
    }
    const text = toAIFormat(source);
    const size = text.length;
    copyText(text)
      .then(() => {
        setStatus(`Copied (${size} chars).`);
      })
      .catch(() => {
        setStatus("Copy failed.");
      });
  }

  function onPick() {
    if (pickMode) {
      exitPickMode();
      setStatus("Pick off.");
      return;
    }
    const selectionSource = getSelectionSource();
    if (selectionSource) {
      copyFromSource(selectionSource);
      return;
    }
    enterPickMode();
  }

  ensureBodyReady(() => {
    addStyle(styles);
    mountPanel();
    startPanelWatch();
    logDebug("Initialized");
  });
})();
