// ==UserScript==
// @name         HFJ-350M Calculator for OpenHamClock
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Adds a portable antenna calculator for the HFJ-350M with multi-language support (DE, EN, JA)
// @author       DO3EET
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const translations = {
        de: {
            title: "📡 HFJ-350M Rechner",
            placeholder: "Band (40m) oder Frequenz (7.1)",
            band: "Band",
            range: "Bereich",
            setup: "SETUP",
            coil: "Spule",
            jumper: "Jumper",
            radial: "Radial",
            telescope_length: "TELESKOPLÄNGE",
            standard: "Standard",
            calculated: "Kalkuliert",
            diff: "Diff",
            sensitivity: "Empfindlichkeit",
            khz_per_cm: "kHz/cm",
            warning_max: "Max überschritten!",
            warning_min: "Zu kurz!",
            error_not_found: "Keine Konfiguration gefunden.",
            note: "HINWEIS",
            // Data translations
            coil_160: "Basis + 3.5 Spule + 1.8 Spule",
            coil_80: "Basis + 3.5 Spule",
            coil_40: "Basis (Keine Zusatzspule)",
            coil_base: "Basis",
            jumper_none: "Kein Jumper",
            note_160: "Extrem schmalbandig! Tuner fast immer nötig.",
            note_40: "Standard-Band für Portable.",
            note_17: "Bei hohem SWR Terminal 2 testen.",
            note_10: "Teleskop NICHT voll ausziehen! Reserve ~26cm.",
            note_6: "Achtung: Terminal 5 = Common + 5"
        },
        en: {
            title: "📡 HFJ-350M Calculator",
            placeholder: "Band (40m) or Freq (7.1)",
            band: "Band",
            range: "Range",
            setup: "SETUP",
            coil: "Coil",
            jumper: "Jumper",
            radial: "Radial",
            telescope_length: "TELESCOPE LENGTH",
            standard: "Standard",
            calculated: "Calculated",
            diff: "Diff",
            sensitivity: "Sensitivity",
            khz_per_cm: "kHz/cm",
            warning_max: "Max exceeded!",
            warning_min: "Too short!",
            error_not_found: "No configuration found.",
            note: "NOTE",
            // Data translations
            coil_160: "Base + 3.5 Coil + 1.8 Coil",
            coil_80: "Base + 3.5 Coil",
            coil_40: "Base (No extra coil)",
            coil_base: "Base",
            jumper_none: "No Jumper",
            note_160: "Extremely narrow band! Tuner almost always needed.",
            note_40: "Standard band for portable use.",
            note_17: "Test Terminal 2 if SWR is high.",
            note_10: "Do NOT extend fully! Keep ~26cm reserve.",
            note_6: "Note: Terminal 5 = Common + 5"
        },
        ja: {
            title: "📡 HFJ-350M アンテナ計算機",
            placeholder: "バンド (例: 40m) または 周波数 (例: 7.1)",
            band: "バンド",
            range: "範囲",
            setup: "セットアップ",
            coil: "コイル",
            jumper: "ジャンパー",
            radial: "ラジアル",
            telescope_length: "エレメント (ロッドアンテナ)",
            standard: "標準",
            calculated: "計算値",
            diff: "標準との差",
            sensitivity: "感度",
            khz_per_cm: "kHz/cm",
            warning_max: "最大値を超えました！",
            warning_min: "短すぎます！",
            error_not_found: "構成が見つかりません。",
            note: "注意",
            // Data translations
            coil_160: "ベース + 3.5コイル + 1.8コイル",
            coil_80: "ベース + 3.5コイル",
            coil_40: "ベース (追加コイルなし)",
            coil_base: "ベース",
            jumper_none: "ジャンパー線なし",
            note_160: "非常に狭帯域です。ほとんどの場合、アンテナチューナーが必要です。",
            note_40: "移動運用の標準バンド。",
            note_17: "SWRが高い場合は端子2を試してください。",
            note_10: "ロッドを最後まで伸ばさないでください！ 予備 約26cm。",
            note_6: "注意: 端子 5 = 共通 + 5"
        }
    };

    // Detect language
    let lang = 'en';
    const htmlLang = document.documentElement.lang.toLowerCase();
    if (htmlLang.startsWith('de')) lang = 'de';
    else if (htmlLang.startsWith('ja')) lang = 'ja';
    
    // Fallback or override from OpenHamClock settings if possible
    try {
        const savedLang = localStorage.getItem('i18nextLng');
        if (savedLang) {
            if (savedLang.startsWith('de')) lang = 'de';
            else if (savedLang.startsWith('ja')) lang = 'ja';
            else if (savedLang.startsWith('en')) lang = 'en';
        }
    } catch(e) {}

    const t = (key) => translations[lang][key] || translations['en'][key] || key;

    const ANTENNA_DATA = [
        { band: "160m", freq_range: [1.8, 2.0], std_freq: 1.8, coil: "coil_160", jumper: "jumper_none", length_mm: 1170, radial: "> 20m (ideal 40m)", change_per_cm: 7, note: "note_160" },
        { band: "80m", freq_range: [3.5, 3.8], std_freq: 3.5, coil: "coil_80", jumper: "jumper_none", length_mm: 910, radial: "ca. 20m", change_per_cm: 20, note: "" },
        { band: "40m", freq_range: [7.0, 7.2], std_freq: 7.0, coil: "coil_40", jumper: "jumper_none", length_mm: 960, radial: "ca. 12m", change_per_cm: 25, note: "note_40" },
        { band: "30m", freq_range: [10.1, 10.15], std_freq: 10.1, coil: "coil_base", jumper: "Terminal 1", length_mm: 990, radial: "ca. 7-8m", change_per_cm: 40, note: "" },
        { band: "20m", freq_range: [14.0, 14.35], std_freq: 14.0, coil: "coil_base", jumper: "Terminal 2", length_mm: 800, radial: "ca. 5m", change_per_cm: 60, note: "" },
        { band: "17m", freq_range: [18.068, 18.168], std_freq: 18.0, coil: "coil_base", jumper: "Terminal 3 (oder 2)", length_mm: 1070, radial: "ca. 4m", change_per_cm: 50, note: "note_17" },
        { band: "15m", freq_range: [21.0, 21.45], std_freq: 21.0, coil: "coil_base", jumper: "Terminal 3", length_mm: 750, radial: "ca. 3.5m", change_per_cm: 80, note: "" },
        { band: "12m", freq_range: [24.89, 24.99], std_freq: 24.9, coil: "coil_base", jumper: "Terminal 3", length_mm: 530, radial: "ca. 3m", change_per_cm: 100, note: "" },
        { band: "10m", freq_range: [28.0, 29.7], std_freq: 28.5, coil: "coil_base", jumper: "Terminal 4", length_mm: 1000, radial: "ca. 2.5m", change_per_cm: 120, note: "note_10" },
        { band: "6m", freq_range: [50.0, 52.0], std_freq: 51.0, coil: "coil_base", jumper: "Terminal 5", length_mm: 950, radial: "ca. 1.5m", change_per_cm: 100, note: "note_6" }
    ];

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

        #hfj-calc-container {
...
    function init() {
        if (!document.body) return;

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

        // Add HFJ Icon to Drawer
        const toggleBtn = document.createElement("div");
        toggleBtn.id = "hfj-toggle-btn";
        toggleBtn.className = "ohc-addon-icon ohc-addon-item";
        toggleBtn.innerHTML = "📡";
        toggleBtn.title = t('title');
        drawer.appendChild(toggleBtn);

        // Add Container
...

        const input = document.getElementById("hfj-calc-input");
        const results = document.getElementById("hfj-results");
        const closeBtn = document.getElementById("hfj-close");

        toggleBtn.onclick = () => {
            const isVisible = container.style.display === "flex";
            container.style.display = isVisible ? "none" : "flex";
        };

        closeBtn.onclick = () => {
            container.style.display = "none";
        };

        input.oninput = (e) => {
            const val = e.target.value;
            calculate(val);
            localStorage.setItem('hfj350m-last-input', val);
        };

        // Draggable logic
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const header = document.getElementById("hfj-calc-header");
        header.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            container.style.top = (container.offsetTop - pos2) + "px";
            container.style.left = (container.offsetLeft - pos1) + "px";
            container.style.right = 'auto';
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }

        const savedInput = localStorage.getItem('hfj350m-last-input');
        if (savedInput) {
            input.value = savedInput;
            calculate(savedInput);
        }
    }

    function calculate(query) {
        const results = document.getElementById("hfj-results");
        if (!query) {
            results.innerHTML = "";
            return;
        }

        const queryStr = String(query).toLowerCase().trim();
        let targetFreq = null;
        let data = null;

        data = ANTENNA_DATA.find(d => {
            const bandName = d.band.replace("m", "");
            return queryStr === d.band.toLowerCase() || queryStr === bandName;
        });

        if (!data) {
            const freq = parseFloat(queryStr.replace(',', '.'));
            if (!isNaN(freq)) {
                targetFreq = freq;
                data = ANTENNA_DATA.find(d => {
                    const [low, high] = d.freq_range;
                    return (low - 0.5) <= freq && freq <= (high + 1.0);
                });
            }
        }

        if (!data) {
            results.innerHTML = `<div class="hfj-accent-red" style="text-align:center;">${t('error_not_found')}</div>`;
            return;
        }

        let calcLenMm = data.length_mm;
        let diffMm = 0;
        let warning = "";

        if (targetFreq) {
            const diffKhz = (targetFreq - data.std_freq) * 1000;
            const changeCm = diffKhz / data.change_per_cm;
            calcLenMm = Math.round(data.length_mm - (changeCm * 10));

            if (calcLenMm > 1266) {
                warning = t('warning_max');
                calcLenMm = 1266;
            } else if (calcLenMm < 100) {
                warning = t('warning_min');
                calcLenMm = 100;
            }
            diffMm = calcLenMm - data.length_mm;
        }

        const maxLen = 1266;
        const stdPercent = (data.length_mm / maxLen) * 100;
        const calcPercent = (calcLenMm / maxLen) * 100;

        results.innerHTML = `
            <div style="border-bottom: 1px solid var(--border-color, rgba(255,180,50,0.1)); padding-bottom: 8px; margin-bottom: 8px;">
                <div class="hfj-row">
                    <span class="hfj-label">${t('band')}:</span>
                    <span class="hfj-value hfj-accent-cyan">${data.band}</span>
                </div>
                <div class="hfj-row">
                    <span class="hfj-label">${t('range')}:</span>
                    <span>${data.freq_range[0]} - ${data.freq_range[1]} MHz</span>
                </div>
            </div>

            <div style="margin-bottom: 10px;">
                <div style="color: var(--text-muted); font-size: 11px; margin-bottom: 4px; text-transform: uppercase;">${t('setup')}</div>
                <div class="hfj-row"><span class="hfj-label">${t('coil')}:</span><span>${t(data.coil)}</span></div>
                <div class="hfj-row"><span class="hfj-label">${t('jumper')}:</span><span class="hfj-accent-green">${t(data.jumper)}</span></div>
                <div class="hfj-row"><span class="hfj-label">${t('radial')}:</span><span>${data.radial}</span></div>
            </div>

            <div style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; margin-bottom: 8px;">
                <div style="color: var(--text-muted); font-size: 11px; margin-bottom: 4px; text-transform: uppercase;">${t('telescope_length')}</div>
                
                <div class="hfj-row">
                    <span style="font-size: 12px;">${t('standard')} (${data.std_freq} MHz):</span>
                    <span class="hfj-accent-amber hfj-value">${data.length_mm} mm</span>
                </div>
                <div class="hfj-bar-bg"><div class="hfj-bar-fill" style="width: ${stdPercent}%; background: var(--accent-amber, #ffb432);"></div></div>

                ${targetFreq ? `
                    <div class="hfj-row">
                        <span style="font-size: 12px;">${t('calculated')} (${targetFreq} MHz):</span>
                        <span class="hfj-accent-purple hfj-value">
                            ${calcLenMm} mm
                            ${warning ? `<span class="hfj-accent-red" style="margin-left: 5px;">⚠ ${warning}</span>` : ''}
                        </span>
                    </div>
                    <div class="hfj-bar-bg"><div class="hfj-bar-fill" style="width: ${calcPercent}%; background: var(--accent-purple, #aa66ff);"></div></div>
                    <div style="font-size: 11px; text-align: right; margin-top: -6px; color: ${diffMm >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
                        ${t('diff')}: ${diffMm > 0 ? '+' : ''}${diffMm} mm
                    </div>
                ` : ''}
            </div>

            <div style="font-size: 11px; color: var(--text-secondary);">
                <div>${t('sensitivity')}: <span style="color: var(--text-primary);">${data.change_per_cm} ${t('khz_per_cm')}</span></div>
                ${data.note ? `<div class="hfj-accent-red" style="margin-top: 4px;">⚠ ${t(data.note)}</div>` : ''}
            </div>
        `;
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
