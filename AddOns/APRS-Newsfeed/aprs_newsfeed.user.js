// ==UserScript==
// @name         APRS Newsfeed (Inbox) for OpenHamClock
// @namespace    http://tampermonkey.net/
// @version      1.3
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
        #ohc-addon-drawer {
            position: fixed;
            bottom: 20px;
            right: 20px;
            display: flex;
            flex-direction: row-reverse;
            align-items: center;
            gap: 10px;
            z-index: 10000;
            pointer-events: none;
        }
        .ohc-addon-icon {
            position: relative;
            width: 45px;
            height: 45px;
            background: var(--bg-panel, rgba(17, 24, 32, 0.95));
            border: 1px solid var(--border-color, rgba(255, 180, 50, 0.3));
            border-radius: 50%;
            color: var(--accent-cyan, #00ddff);
            font-size: 20px;
            cursor: pointer;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            pointer-events: auto;
            transition: all 0.3s ease;
        }
        .ohc-addon-icon:hover { border-color: var(--accent-amber, #ffb432); transform: scale(1.1); }
        
        #ohc-addon-launcher { background: var(--bg-tertiary, #1a2332); color: var(--accent-amber); }
        .ohc-addon-item { display: none; } /* Hidden by default */

        #aprs-news-container {
...
    function init() {
        if (!document.body) return;
        callsign = getCallsign();

        // Add Shared Styles
        if (!document.getElementById("ohc-addon-styles")) {
            const styleSheet = document.createElement("style");
            styleSheet.id = "ohc-addon-styles";
            styleSheet.innerText = styles;
            document.head.appendChild(styleSheet);
        }

        // Get or Create Drawer
        let drawer = document.getElementById("ohc-addon-drawer");
        if (!drawer) {
            drawer = document.createElement("div");
            drawer.id = "ohc-addon-drawer";
            
            const launcher = document.createElement("div");
            launcher.id = "ohc-addon-launcher";
            launcher.className = "ohc-addon-icon";
            launcher.innerHTML = "🧩";
            launcher.title = "AddOns";
            launcher.onclick = () => {
                const items = document.querySelectorAll(".ohc-addon-item");
                const isHidden = items[0]?.style.display !== "flex";
                items.forEach(el => el.style.display = isHidden ? "flex" : "none");
                launcher.style.transform = isHidden ? "rotate(90deg)" : "rotate(0deg)";
            };
            
            drawer.appendChild(launcher);
            document.body.appendChild(drawer);
        }

        // Add APRS Icon to Drawer
        const toggleBtn = document.createElement("div");
        toggleBtn.id = "aprs-toggle-btn";
        toggleBtn.className = "ohc-addon-icon ohc-addon-item";
        toggleBtn.innerHTML = `📩<div id="aprs-news-badge" class="aprs-badge"></div>`;
        toggleBtn.title = t('title');
        drawer.appendChild(toggleBtn);

        // Add Container
...

        const closeBtn = document.getElementById("aprs-close");
        const settingsBtn = document.getElementById("aprs-settings-toggle");
        const saveBtn = document.getElementById("aprs-save-btn");
        const apiKeyInput = document.getElementById("aprs-apikey-input");
        const settingsDiv = document.getElementById("aprs-news-settings");

        toggleBtn.onclick = () => {
            const isVisible = container.style.display === "flex";
            container.style.display = isVisible ? "none" : "flex";
            if (!isVisible) {
                document.getElementById("aprs-news-badge").style.display = "none";
                fetchMessages();
            }
        };

        closeBtn.onclick = () => container.style.display = "none";
        
        settingsBtn.onclick = () => {
            const isVisible = settingsDiv.style.display === "block";
            settingsDiv.style.display = isVisible ? "none" : "block";
        };

        saveBtn.onclick = () => {
            apiKey = apiKeyInput.value.trim();
            localStorage.setItem(STORAGE_API_KEY, apiKey);
            settingsDiv.style.display = "none";
            fetchMessages();
        };

        // Draggable
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const header = document.getElementById("aprs-news-header");
        header.onmousedown = (e) => {
            if (e.target.classList.contains('aprs-icon-btn')) return;
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
            const sortedEntries = (data.entries || []).sort((a, b) => b.time - a.time);
            renderMessages(sortedEntries);
            status.innerText = `${t('last_update')}: ${new Date().toLocaleTimeString()}`;
            
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
