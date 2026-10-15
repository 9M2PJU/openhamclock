/**
 * cwDecoderWorklet.js — AudioWorkletProcessor that runs the CW decoder.
 *
 * A thin wrapper: every 128-sample render quantum goes into CWPipeline
 * (src/utils/cwDecoder.js — all the DSP lives there and is unit-tested).
 * Decoded text and meter state are posted to the main thread ~10× a second.
 *
 * Loaded with `audioWorklet.addModule(url)` where url comes from
 * `import url from './cwDecoderWorklet.js?worker&url'` — Vite bundles this
 * file together with its import into one script.
 *
 * Messages in (port):  { type: 'tone', hz } | { type: 'bandwidth', value: 'auto'|Hz }
 *                      { type: 'squelch', level: 'low'|'normal'|'high' } | { type: 'reset' }
 *                      { type: 'find', seconds }   — scan for the strongest tone, then lock to it
 * Messages out:        { type: 'update', text, state, found? }
 */
/* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */
import { CWPipeline } from '../utils/cwDecoder.js';

const POST_INTERVAL_S = 0.1;

class CWDecoderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.text = '';
    this.found = null;
    this.findUntil = 0;
    this.lastPost = 0;
    this.pipe = new CWPipeline({
      sampleRate,
      tone: o.tone || 600,
      bandwidth: o.bandwidth || 'auto',
      squelch: o.squelch || 'normal',
      onText: (t) => {
        this.text += t;
      },
    });
    this.port.onmessage = (e) => this.onMessage(e.data || {});
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'tone':
        this.pipe.setTone(Number(msg.hz));
        break;
      case 'bandwidth':
        this.pipe.setBandwidth(msg.value === 'auto' ? 'auto' : Number(msg.value));
        break;
      case 'squelch':
        this.pipe.setSquelch(String(msg.level));
        break;
      case 'reset':
        this.pipe.reset();
        break;
      case 'find':
        this.pipe.enableToneFinder(false);
        this.pipe.enableToneFinder(true);
        this.findUntil = currentTime + (Number(msg.seconds) || 3);
        break;
      default:
        break;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.pipe.process(ch);

    if (this.findUntil && currentTime >= this.findUntil) {
      this.findUntil = 0;
      const best = this.pipe.finder ? this.pipe.finder.best() : null;
      this.pipe.enableToneFinder(false);
      // Only retune when there really is a tone standing out of the noise
      if (best && best.snrDb >= 6) {
        this.pipe.setTone(best.freq);
        this.pipe.reset();
        this.found = { freq: best.freq, snrDb: best.snrDb };
      } else {
        this.found = { freq: null, snrDb: best ? best.snrDb : 0 };
      }
    }

    if (currentTime - this.lastPost >= POST_INTERVAL_S) {
      this.lastPost = currentTime;
      this.port.postMessage({
        type: 'update',
        text: this.text,
        state: { ...this.pipe.getState(), finding: !!this.findUntil },
        found: this.found,
      });
      this.text = '';
      this.found = null;
    }
    return true;
  }
}

registerProcessor('cw-decoder', CWDecoderProcessor);
