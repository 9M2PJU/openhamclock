// ==UserScript==
// @name         APRS Newsfeed (Inbox) for OpenHamClock
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Fetches and displays your latest APRS messages from aprs.fi
// @author       DO3EET
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      aprs.fi
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_API_KEY = 'ohc_aprsfi_apikey';
    const POLL_INTERVAL = 300000; // 5 minutes (respect API limits)

    const translations = {
        de: {
            title: "📩 APRS Newsfeed",
            placeholder_apikey: "aprs.fi API Key",
            inbox_for: "Inbox für",
            no_messages: "Keine Nachrichten gefunden.",
            last_update: "Letztes Update",
            save: "Speichern",
            from: "Von",
            to: "An",
            time: "Zeit",
            error_api: "API Fehler. Key prüfen?",
            error_no_call: "Kein Rufzeichen gefunden!",
            setup_required: "Bitte API-Key in Einstellungen eingeben."
        },
        en: {
            title: "📩 APRS Newsfeed",
            placeholder_apikey: "aprs.fi API Key",
            inbox_for: "Inbox for",
            no_messages: "No messages found.",
            last_update: "Last update",
            save: "Save",
            from: "From",
            to: "To",
            time: "Time",
            error_api: "API Error. Check key?",
            error_no_call: "No callsign found!",
            setup_required: "Please enter API Key in settings."
        },
        ja: {
            title: "📩 APRS ニュースフィード",
            placeholder_apikey: "aprs.fi API キー",
            inbox_for: "受信トレイ:",
            no_messages: "メッセージは見つかりませんでした。",
            last_update: "最終更新",
            save: "保存",
            from: "送信元",
            to: "宛先",
            time: "時刻",
            error_api: "API エラー。キーを確認してください。",
            error_no_call: "コールサインが見つかりません！",
            setup_required: "設定で API キーを入力してください。"
        }
    };

    // Detect language
    let lang = 'en';
    const htmlLang = document.documentElement.lang.toLowerCase();
    if (htmlLang.startsWith('de')) lang = 'de';
    else if (htmlLang.startsWith('ja')) lang = 'ja';
    
    try {
        const savedLang = localStorage.getItem('i18nextLng');
        if (savedLang) {
            if (savedLang.startsWith('de')) lang = 'de';
            else if (savedLang.startsWith('ja')) lang = 'ja';
            else if (savedLang.startsWith('en')) lang = 'en';
        }
    } catch(e) {}

    const t = (key) => translations[lang][key] || translations['en'][key] || key;

    const styles = `
        #aprs-news-container {
            position: fixed;
            top: 100px;
            right: 20px;
            width: 320px;
            max-height: 500px;
            background: var(--bg-panel, rgba(17, 24, 32, 0.95));
            border: 1px solid var(--border-color, rgba(255, 180, 50, 0.3));
            border-radius: 8px;
            color: var(--text-primary, #f0f4f8);
            font-family: 'JetBrains Mono', monospace, sans-serif;
            z-index: 9998;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            display: none;
            flex-direction: column;
            backdrop-filter: blur(5px);
        }
        #aprs-news-header {
            padding: 10px;
            background: rgba(0, 221, 255, 0.1);
            border-bottom: 1px solid var(--border-color, rgba(255, 180, 50, 0.2));
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-radius: 8px 8px 0 0;
        }
        #aprs-news-header h3 {
            margin: 0;
            font-size: 14px;
            color: var(--accent-cyan, #00ddff);
        }
        #aprs-news-content {
            padding: 0;
            overflow-y: auto;
            flex-grow: 1;
        }
        .aprs-msg-entry {
            padding: 10px;
            border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.05));
            font-size: 12px;
        }
        .aprs-msg-entry:last-child { border-bottom: none; }
        .aprs-msg-meta {
            display: flex;
            justify-content: space-between;
            margin-bottom: 4px;
            font-size: 10px;
            color: var(--text-muted);
        }
        .aprs-msg-call { color: var(--accent-green, #00ff88); font-weight: bold; }
        .aprs-msg-text { color: var(--text-primary); line-height: 1.4; word-break: break-word; }
        
        #aprs-news-settings {
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-top: 1px solid var(--border-color, rgba(255, 180, 50, 0.1));
            font-size: 11px;
        }
        .aprs-input {
            width: 100%;
            padding: 6px;
            background: var(--bg-secondary, #111820);
            border: 1px solid var(--border-color, rgba(255, 180, 50, 0.2));
            color: var(--text-primary);
            border-radius: 4px;
            margin-bottom: 6px;
            box-sizing: border-box;
        }
        #aprs-toggle-btn {
            position: fixed;
            bottom: 75px;
            right: 20px;
            width: 45px;
            height: 45px;
            background: var(--bg-panel, rgba(17, 24, 32, 0.95));
            border: 1px solid var(--border-color, rgba(255, 180, 50, 0.3));
            border-radius: 50%;
            color: var(--accent-cyan, #00ddff);
            font-size: 20px;
            cursor: pointer;
            z-index: 10000;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
        #aprs-toggle-btn:hover {
            border-color: var(--accent-amber, #ffb432);
        }
        .aprs-badge {
            position: absolute;
            top: -2px;
            right: -2px;
            background: var(--accent-red, #ff4466);
            color: white;
            font-size: 10px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            display: none;
            justify-content: center;
            align-items: center;
            border: 2px solid var(--bg-panel);
        }
    `;

    let callsign = 'N0CALL';
    let apiKey = localStorage.getItem(STORAGE_API_KEY) || '';
    let lastMsgId = localStorage.getItem('ohc_aprs_last_msgid') || '0';

    function getCallsign() {
        try {
            const config = JSON.parse(localStorage.getItem('openhamclock_config'));
            if (config && config.callsign && config.callsign !== 'N0CALL') {
                return config.callsign;
            }
        } catch(e) {}
        return 'N0CALL';
    }

    function init() {
        if (!document.body) return;
        callsign = getCallsign();

        const styleSheet = document.createElement("style");
        styleSheet.innerText = styles;
        document.head.appendChild(styleSheet);

        const toggleBtn = document.createElement("div");
        toggleBtn.id = "aprs-toggle-btn";
        toggleBtn.innerHTML = `📩<div id="aprs-news-badge" class="aprs-badge"></div>`;
        toggleBtn.title = t('title');
        document.body.appendChild(toggleBtn);

        const container = document.createElement("div");
        container.id = "aprs-news-container";
        container.innerHTML = `
            <div id="aprs-news-header">
                <h3>${t('title')}</h3>
                <span id="aprs-close" style="cursor:pointer; color:var(--text-muted);">×</span>
            </div>
            <div id="aprs-news-content">
                <div style="padding: 20px; text-align: center; color: var(--text-muted);">${t('setup_required')}</div>
            </div>
            <div id="aprs-news-settings">
                <input type="password" id="aprs-apikey-input" class="aprs-input" placeholder="${t('placeholder_apikey')}" value="${apiKey}">
                <div style="display:flex; justify-content: space-between; align-items: center;">
                    <span id="aprs-status" style="color: var(--text-muted); font-size: 9px;"></span>
                    <button id="aprs-save-btn" style="padding: 4px 8px; cursor: pointer; background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 4px;">${t('save')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(container);

        const closeBtn = document.getElementById("aprs-close");
        const saveBtn = document.getElementById("aprs-save-btn");
        const apiKeyInput = document.getElementById("aprs-apikey-input");

        toggleBtn.onclick = () => {
            const isVisible = container.style.display === "flex";
            container.style.display = isVisible ? "none" : "flex";
            if (!isVisible) {
                document.getElementById("aprs-news-badge").style.display = "none";
                fetchMessages();
            }
        };

        closeBtn.onclick = () => container.style.display = "none";

        saveBtn.onclick = () => {
            apiKey = apiKeyInput.value.trim();
            localStorage.setItem(STORAGE_API_KEY, apiKey);
            fetchMessages();
        };

        // Draggable
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const header = document.getElementById("aprs-news-header");
        header.onmousedown = (e) => {
            e.preventDefault();
            pos3 = e.clientX; pos4 = e.clientY;
            document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
            document.onmousemove = (e) => {
                e.preventDefault();
                pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
                pos3 = e.clientX; pos4 = e.clientY;
                container.style.top = (container.offsetTop - pos2) + "px";
                container.style.left = (container.offsetLeft - pos1) + "px";
                container.style.right = 'auto';
            };
        };

        if (apiKey) fetchMessages();
        setInterval(fetchMessages, POLL_INTERVAL);
    }

    async function fetchMessages() {
        if (!apiKey) return;
        const baseCall = getCallsign();
        if (baseCall === 'N0CALL') {
             document.getElementById("aprs-news-content").innerHTML = `<div style="padding: 20px; text-align: center; color: var(--accent-red);">${t('error_no_call')}</div>`;
             return;
        }

        const status = document.getElementById("aprs-status");
        status.innerText = "Loading...";

        // Construct query: if base call, add common SSIDs
        let queryCalls = baseCall;
        if (!baseCall.includes('-')) {
            queryCalls = `${baseCall},${baseCall}-7,${baseCall}-9,${baseCall}-10,${baseCall}-1,${baseCall}-2`;
        }

        const url = `https://api.aprs.fi/api/get?what=msg&dst=${queryCalls}&apikey=${apiKey}&format=json`;

        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        handleResponse(data);
                    } catch (e) {
                        status.innerText = "Parse Error";
                    }
                },
                onerror: function(err) {
                    status.innerText = "Network Error (GM)";
                }
            });
        } else {
            // Fallback for environments without GM_xmlhttpRequest (will likely hit CORS)
            try {
                const response = await fetch(url);
                const data = await response.json();
                handleResponse(data);
            } catch (e) {
                document.getElementById("aprs-news-content").innerHTML = `<div style="padding: 20px; text-align: center; color: var(--accent-red);">CORS Error. Use Tampermonkey/Greasemonkey!</div>`;
                status.innerText = "CORS Error";
            }
        }
    }

    function handleResponse(data) {
        const status = document.getElementById("aprs-status");
        if (data.result === 'ok') {
            // Sort entries by time descending (api might return mixed SSIDs)
            const sortedEntries = (data.entries || []).sort((a, b) => b.time - a.time);
            renderMessages(sortedEntries);
            status.innerText = `${t('last_update')}: ${new Date().toLocaleTimeString()}`;
            
            // Check for new messages
            if (sortedEntries.length > 0) {
                const latest = sortedEntries[0].messageid;
                if (latest > lastMsgId && document.getElementById("aprs-news-container").style.display !== "flex") {
                    const badge = document.getElementById("aprs-news-badge");
                    badge.innerText = "!";
                    badge.style.display = "flex";
                }
                lastMsgId = latest;
                localStorage.setItem('ohc_aprs_last_msgid', lastMsgId);
            }
        } else {
            document.getElementById("aprs-news-content").innerHTML = `<div style="padding: 20px; text-align: center; color: var(--accent-red);">${t('error_api')}: ${data.description || ''}</div>`;
            status.innerText = "Error";
        }
    }

    function renderMessages(entries) {
        const content = document.getElementById("aprs-news-content");
        if (!entries || entries.length === 0) {
            content.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">${t('no_messages')}</div>`;
            return;
        }

        content.innerHTML = entries.map(entry => {
            const timeStr = new Date(entry.time * 1000).toLocaleString([], {hour: '2-digit', minute:'2-digit', day: '2-digit', month: '2-digit'});
            const isToSSID = entry.dst.includes('-');
            return `
                <div class="aprs-msg-entry">
                    <div class="aprs-msg-meta">
                        <span>${t('from')}: <span class="aprs-msg-call">${entry.srccall}</span></span>
                        <span>${timeStr}</span>
                    </div>
                    <div class="aprs-msg-text">${entry.message}</div>
                    <div style="font-size: 9px; color: var(--text-muted); text-align: right; margin-top: 2px;">
                        ${t('to')}: <span style="color: ${isToSSID ? 'var(--accent-amber)' : 'var(--text-secondary)'}">${entry.dst}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();

