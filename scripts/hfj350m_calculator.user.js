// ==UserScript==
// @name         HFJ-350M Calculator for OpenHamClock
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a portable antenna calculator for the HFJ-350M to OpenHamClock
// @author       DO3EET
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Antenna data from the manual
    const ANTENNA_DATA = [
        { band: "160m", freq_range: [1.8, 2.0], std_freq: 1.8, coil: "Basis + 3.5 Spule + 1.8 Spule", jumper: "Kein Jumper", length_mm: 1170, radial: "> 20m (ideal 40m)", change_per_cm: 7, note: "Extrem schmalbandig! Tuner fast immer nötig." },
        { band: "80m", freq_range: [3.5, 3.8], std_freq: 3.5, coil: "Basis + 3.5 Spule", jumper: "Kein Jumper", length_mm: 910, radial: "ca. 20m", change_per_cm: 20, note: "" },
        { band: "40m", freq_range: [7.0, 7.2], std_freq: 7.0, coil: "Basis (Keine Zusatzspule)", jumper: "Kein Jumper", length_mm: 960, radial: "ca. 12m", change_per_cm: 25, note: "Standard-Band für Portable." },
        { band: "30m", freq_range: [10.1, 10.15], std_freq: 10.1, coil: "Basis", jumper: "Terminal 1", length_mm: 990, radial: "ca. 7-8m", change_per_cm: 40, note: "" },
        { band: "20m", freq_range: [14.0, 14.35], std_freq: 14.0, coil: "Basis", jumper: "Terminal 2", length_mm: 800, radial: "ca. 5m", change_per_cm: 60, note: "" },
        { band: "17m", freq_range: [18.068, 18.168], std_freq: 18.0, coil: "Basis", jumper: "Terminal 3 (oder 2)", length_mm: 1070, radial: "ca. 4m", change_per_cm: 50, note: "Bei hohem SWR Terminal 2 testen." },
        { band: "15m", freq_range: [21.0, 21.45], std_freq: 21.0, coil: "Basis", jumper: "Terminal 3", length_mm: 750, radial: "ca. 3.5m", change_per_cm: 80, note: "" },
        { band: "12m", freq_range: [24.89, 24.99], std_freq: 24.9, coil: "Basis", jumper: "Terminal 3", length_mm: 530, radial: "ca. 3m", change_per_cm: 100, note: "" },
        { band: "10m", freq_range: [28.0, 29.7], std_freq: 28.5, coil: "Basis", jumper: "Terminal 4", length_mm: 1000, radial: "ca. 2.5m", change_per_cm: 120, note: "Teleskop NICHT voll ausziehen! Reserve ~26cm." },
        { band: "6m", freq_range: [50.0, 52.0], std_freq: 51.0, coil: "Basis", jumper: "Terminal 5", length_mm: 950, radial: "ca. 1.5m", change_per_cm: 100, note: "Achtung: Terminal 5 = Common + 5" }
    ];

    const styles = `
        #hfj-calc-container {
            position: fixed;
            top: 60px;
            right: 20px;
            width: 280px;
            background: var(--bg-panel, rgba(17, 24, 32, 0.95));
            border: 1px solid var(--border-color, rgba(255, 180, 50, 0.3));
            border-radius: 8px;
            color: var(--text-primary, #f0f4f8);
            font-family: 'JetBrains Mono', monospace, sans-serif;
            z-index: 9999;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            display: none;
            flex-direction: column;
            backdrop-filter: blur(5px);
        }
        #hfj-calc-header {
            padding: 10px;
            background: rgba(255, 180, 50, 0.1);
            border-bottom: 1px solid var(--border-color, rgba(255, 180, 50, 0.2));
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-radius: 8px 8px 0 0;
        }
        #hfj-calc-header h3 {
            margin: 0;
            font-size: 14px;
            color: var(--accent-cyan, #00ddff);
        }
        #hfj-calc-content {
            padding: 12px;
            font-size: 13px;
        }
        #hfj-calc-input {
            width: 100%;
            padding: 8px;
            background: var(--bg-secondary, #111820);
            border: 1px solid var(--border-color, rgba(255, 180, 50, 0.2));
            color: var(--text-primary, #f0f4f8);
            border-radius: 4px;
            margin-bottom: 12px;
            box-sizing: border-box;
            outline: none;
        }
        #hfj-calc-input:focus {
            border-color: var(--accent-amber, #ffb432);
        }
        .hfj-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 4px;
        }
        .hfj-label { color: var(--text-secondary, #a0b0c0); }
        .hfj-value { font-weight: bold; }
        .hfj-accent-cyan { color: var(--accent-cyan, #00ddff); }
        .hfj-accent-green { color: var(--accent-green, #00ff88); }
        .hfj-accent-amber { color: var(--accent-amber, #ffb432); }
        .hfj-accent-purple { color: var(--accent-purple, #aa66ff); }
        .hfj-accent-red { color: var(--accent-red, #ff4466); }
        
        .hfj-bar-bg {
            width: 100%;
            height: 6px;
            background: var(--bg-tertiary, #1a2332);
            border-radius: 3px;
            margin: 4px 0 10px 0;
            overflow: hidden;
        }
        .hfj-bar-fill {
            height: 100%;
            transition: width 0.3s ease;
        }
        #hfj-toggle-btn {
            position: fixed;
            bottom: 20px;
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
        #hfj-toggle-btn:hover {
            background: var(--bg-tertiary, #1a2332);
            border-color: var(--accent-amber, #ffb432);
        }
    `;

    function init() {
        if (!document.body) return;

        // Add Styles
        const styleSheet = document.createElement("style");
        styleSheet.innerText = styles;
        document.head.appendChild(styleSheet);

        // Add Toggle Button
        const toggleBtn = document.createElement("div");
        toggleBtn.id = "hfj-toggle-btn";
        toggleBtn.innerHTML = "📡";
        toggleBtn.title = "HFJ-350M Calculator";
        document.body.appendChild(toggleBtn);

        // Add Container
        const container = document.createElement("div");
        container.id = "hfj-calc-container";
        container.innerHTML = `
            <div id="hfj-calc-header">
                <h3>📡 HFJ-350M Calculator</h3>
                <span id="hfj-close" style="cursor:pointer; color:var(--text-muted);">×</span>
            </div>
            <div id="hfj-calc-content">
                <input type="text" id="hfj-calc-input" placeholder="Band (40m) or Freq (7.1)">
                <div id="hfj-results"></div>
            </div>
        `;
        document.body.appendChild(container);

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
            container.style.right = 'auto'; // Disable right-lock after dragging
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }

        // Initial Calculation
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

        // Check if input is a band name
        data = ANTENNA_DATA.find(d => {
            const bandName = d.band.replace("m", "");
            return queryStr === d.band.toLowerCase() || queryStr === bandName;
        });

        // Check if input is a frequency
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
            results.innerHTML = `<div class="hfj-accent-red" style="text-align:center;">Keine Konfiguration gefunden.</div>`;
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
                warning = "Max überschritten!";
                calcLenMm = 1266;
            } else if (calcLenMm < 100) {
                warning = "Zu kurz!";
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
                    <span class="hfj-label">Band:</span>
                    <span class="hfj-value hfj-accent-cyan">${data.band}</span>
                </div>
                <div class="hfj-row">
                    <span class="hfj-label">Range:</span>
                    <span>${data.freq_range[0]} - ${data.freq_range[1]} MHz</span>
                </div>
            </div>

            <div style="margin-bottom: 10px;">
                <div style="color: var(--text-muted); font-size: 11px; margin-bottom: 4px; text-transform: uppercase;">Setup</div>
                <div class="hfj-row"><span class="hfj-label">Coil:</span><span>${data.coil}</span></div>
                <div class="hfj-row"><span class="hfj-label">Jumper:</span><span class="hfj-accent-green">${data.jumper}</span></div>
                <div class="hfj-row"><span class="hfj-label">Radial:</span><span>${data.radial}</span></div>
            </div>

            <div style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; margin-bottom: 8px;">
                <div style="color: var(--text-muted); font-size: 11px; margin-bottom: 4px; text-transform: uppercase;">Telescope Length</div>
                
                <div class="hfj-row">
                    <span style="font-size: 12px;">Standard (${data.std_freq} MHz):</span>
                    <span class="hfj-accent-amber hfj-value">${data.length_mm} mm</span>
                </div>
                <div class="hfj-bar-bg"><div class="hfj-bar-fill" style="width: ${stdPercent}%; background: var(--accent-amber, #ffb432);"></div></div>

                ${targetFreq ? `
                    <div class="hfj-row">
                        <span style="font-size: 12px;">Calc (${targetFreq} MHz):</span>
                        <span class="hfj-accent-purple hfj-value">
                            ${calcLenMm} mm
                            ${warning ? `<span class="hfj-accent-red" style="margin-left: 5px;">⚠ ${warning}</span>` : ''}
                        </span>
                    </div>
                    <div class="hfj-bar-bg"><div class="hfj-bar-fill" style="width: ${calcPercent}%; background: var(--accent-purple, #aa66ff);"></div></div>
                    <div style="font-size: 11px; text-align: right; margin-top: -6px; color: ${diffMm >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
                        Diff: ${diffMm > 0 ? '+' : ''}${diffMm} mm
                    </div>
                ` : ''}
            </div>

            <div style="font-size: 11px; color: var(--text-secondary);">
                <div>Sensitivity: <span style="color: var(--text-primary);">${data.change_per_cm} kHz/cm</span></div>
                ${data.note ? `<div class="hfj-accent-red" style="margin-top: 4px;">⚠ ${data.note}</div>` : ''}
            </div>
        `;
    }

    // Wait for body to be available
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
