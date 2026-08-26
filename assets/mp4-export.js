/*
 * Export MP4 — rendu offline image par image + encodage H.264 (WebCodecs), muxé avec mp4-muxer.
 * Le rendu ne dépend pas du temps réel : chaque frame est calculée avec un pas fixe,
 * donc la vidéo est fluide même si le calcul du champ est plus lent que le temps réel.
 */
(function () {
  'use strict';

  const DURATION_S = 10;
  const KEYFRAME_EVERY_S = 2;
  const BITRATE_PER_PIXEL = 0.12;   // bits par pixel et par seconde
  const MAX_BITRATE = 20e6;
  const QUEUE_LIMIT = 8;            // backpressure de l'encodeur

  const FORMATS = {
    square:    { w: 1080, h: 1080 },
    landscape: { w: 1920, h: 1080 },
    portrait:  { w: 1080, h: 1920 }
  };

  // Du plus au moins capable — le premier supporté gagne.
  const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'];

  const btn = document.getElementById('mp4Btn');
  const bar = document.getElementById('mp4Bar');
  const progress = document.getElementById('mp4Progress');
  const hint = document.getElementById('mp4Hint');
  const formatSel = document.getElementById('vidFormat');
  const fpsSel = document.getElementById('vidFps');
  const pngBtn = document.getElementById('exportBtn');
  const playBtn = document.getElementById('playBtn');

  const IDLE_LABEL = 'Export MP4 · ' + DURATION_S + ' s';

  function showHint(message) {
    hint.textContent = message;
    hint.hidden = !message;
  }

  function setProgress(ratio) {
    progress.hidden = ratio === null;
    bar.style.transform = 'scaleX(' + (ratio || 0) + ')';
  }

  function setBusy(busy) {
    [btn, pngBtn, playBtn, formatSel, fpsSel].forEach(el => { el.disabled = busy; });
    if (!busy) btn.textContent = IDLE_LABEL;
  }

  // Laisser respirer le thread principal, sans jamais affamer l'encodeur.
  // Un yield par MessageChannel serait prioritaire sur les callbacks de VideoEncoder :
  // la file ne se viderait jamais et l'export se bloquerait. On s'en tient donc à un
  // macrotask classique, et uniquement quand l'onglet est visible — en arrière-plan,
  // setTimeout est bridé à >= 1 s et il n'y a de toute façon rien à repeindre.
  const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

  // Backpressure : on attend l'événement 'dequeue' plutôt que de sonder encodeQueueSize.
  // Événementiel, donc ni attente active ni dépendance aux timers.
  function waitForCapacity(encoder) {
    if (encoder.encodeQueueSize <= QUEUE_LIMIT) return Promise.resolve();
    if (typeof encoder.addEventListener !== 'function') return macrotask();
    return new Promise(resolve => {
      const onDequeue = () => {
        if (encoder.encodeQueueSize > QUEUE_LIMIT) return;
        encoder.removeEventListener('dequeue', onDequeue);
        resolve();
      };
      encoder.addEventListener('dequeue', onDequeue);
    });
  }

  async function pickCodecConfig(width, height, fps) {
    const bitrate = Math.min(MAX_BITRATE, Math.round(width * height * fps * BITRATE_PER_PIXEL));
    for (const codec of CODECS) {
      const config = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
      const support = await VideoEncoder.isConfigSupported(config);
      if (support && support.supported) return config;
    }
    return null;
  }

  async function exportMp4() {
    const { w: width, h: height } = FORMATS[formatSel.value];
    const fps = parseInt(fpsSel.value, 10);
    const totalFrames = DURATION_S * fps;
    const frameDurationUs = Math.round(1e6 / fps);
    const dtMs = 1000 / fps;

    const config = await pickCodecConfig(width, height, fps);
    if (!config) throw new Error('Aucun profil H.264 supporté pour ' + width + '×' + height + '.');

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width, height, frameRate: fps },
      fastStart: 'in-memory'
    });

    // Une erreur d'encodeur doit interrompre l'export où qu'on en soit — y compris
    // pendant l'attente de capacité, qui sinon ne se résoudrait jamais.
    let signalFailure;
    const failed = new Promise((_, reject) => { signalFailure = reject; });
    failed.catch(() => {});   // évite un rejet non géré si l'export se termine normalement

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: err => signalFailure(err)
    });
    encoder.configure(config);

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const outCtx = out.getContext('2d');

    // Copie de l'état : l'export ne doit pas faire sauter l'aperçu en cours.
    const params = readParams();
    const sim = {
      tgtPx: state.tgtPx, tgtPy: state.tgtPy,
      curPx: state.curPx, curPy: state.curPy,
      phase: state.phase, rotAngle: state.rotAngle
    };

    try {
      for (let i = 0; i < totalFrames; i++) {
        const [ex, ey] = advance(sim, params, dtMs);
        paintField(outCtx, width, height, params, ex, ey, sim.phase);

        const frame = new VideoFrame(out, {
          timestamp: Math.round(i * frameDurationUs),
          duration: frameDurationUs
        });
        encoder.encode(frame, { keyFrame: i % (fps * KEYFRAME_EVERY_S) === 0 });
        frame.close();

        btn.textContent = 'Rendu ' + Math.round((i + 1) / totalFrames * 100) + ' %';
        setProgress((i + 1) / totalFrames);

        await Promise.race([waitForCapacity(encoder), failed]);
        if (document.visibilityState === 'visible') await macrotask();
      }

      btn.textContent = 'Encodage…';
      await Promise.race([encoder.flush(), failed]);
      muxer.finalize();
    } finally {
      try { if (encoder.state !== 'closed') encoder.close(); } catch (ignored) { /* déjà fermé */ }
    }

    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  function download(blob, width, height, fps) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'circulr-motif-' + DURATION_S + 's-' + width + 'x' + height + '-' + fps + 'fps.mp4';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (typeof VideoEncoder === 'undefined' || typeof Mp4Muxer === 'undefined') {
    btn.disabled = true;
    btn.textContent = 'Export MP4 indisponible';
    showHint('Ce navigateur ne gère pas WebCodecs. Utilise Chrome, Edge ou Safari 16.4+.');
    return;
  }

  btn.addEventListener('click', async () => {
    const wasPlaying = playing;
    setBusy(true);
    showHint('');
    setProgress(0);
    stopAnim();   // libère le CPU et évite tout conflit sur le canvas de travail

    try {
      const { w, h } = FORMATS[formatSel.value];
      const fps = parseInt(fpsSel.value, 10);
      const blob = await exportMp4();
      download(blob, w, h, fps);
      showHint(Math.round(blob.size / 1e5) / 10 + ' Mo · ' + w + '×' + h + ' · ' + fps + ' fps');
    } catch (err) {
      console.error(err);
      showHint('Export interrompu : ' + (err && err.message ? err.message : err));
    } finally {
      setProgress(null);
      setBusy(false);
      if (wasPlaying) startAnim();
    }
  });
})();
