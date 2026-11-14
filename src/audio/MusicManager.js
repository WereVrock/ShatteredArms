// Background music. Three independent categories — 'menu', 'campaign',
// 'battle' — each backed by a list of tracks in music/manifest.json.
// Within a category, tracks play in random order, looping forever; a
// category switch crossfades (~1.2 s) between the old and new track.
//
// The track list comes from music/manifest.json at the deploy root:
//
//   {
//     "menu":     ["menu-theme.mp3"],
//     "campaign": ["recruit.mp3"],
//     "battle":   ["battle1.mp3", "battle2.mp3"]
//   }
//
// Maintain that file by hand (or with any local script); this module
// never lists directories — browsers cannot.
//
// Autoplay: browsers require a user gesture before audio.play() can
// succeed. init() registers a one-shot pointerdown / keydown /
// touchstart listener that unlocks playback. play() calls arriving
// before the first gesture are queued and fire when the unlock lands.
//
// Settings: subscribes to SettingsStore. Two keys are read here:
//   musicEnabled — false silences the system until re-enabled
//   musicVolume  — 0..1 multiplier on the nominal level
// Both apply live (no reload). There is no settings-UI section yet,
// but any future panel only needs to set() those two keys.
import { SettingsStore } from '../ui/settings/SettingsStore.js';

const MUSIC_ROOT = new URL('../../music/', import.meta.url);
const MANIFEST_URL = new URL('manifest.json', MUSIC_ROOT);
const FADE_MS = 1200;
const DEFAULT_VOLUME = 0.55;

// 1-sample silent WAV. Played once inside the first-gesture handler so
// the audio subsystem is "primed" — subsequent programmatic play()
// calls work even outside the gesture stack on stricter browsers.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|flac|webm|opus)$/i;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function isAudioFilename(fn) {
  return typeof fn === 'string' && AUDIO_EXT.test(fn);
}

class _MusicManager {
  constructor() {
    this.manifest = null;          // { menu:[], campaign:[], battle:[] }
    this.manifestPromise = null;
    this.category = null;          // currently requested category
    this.currentAudio = null;
    this.currentPath = null;
    this.pendingCategory = null;   // queued before the first user gesture
    this.unlocked = false;
    this.gestureBound = false;
    this.unsubSettings = null;
  }

  // Called once at boot from main.js. Registers the gesture unlocker,
  // subscribes to SettingsStore, and starts loading the manifest.
  init() {
    if (!this.gestureBound) {
      this.gestureBound = true;
      const unlock = () => {
        this.unlocked = true;
        this._primeAudio();
        document.removeEventListener('pointerdown', unlock, true);
        document.removeEventListener('keydown', unlock, true);
        document.removeEventListener('touchstart', unlock, true);
        this._tryStartPending();
      };
      document.addEventListener('pointerdown', unlock, true);
      document.addEventListener('keydown', unlock, true);
      document.addEventListener('touchstart', unlock, true);
    }

    if (!this.unsubSettings) {
      this.unsubSettings = SettingsStore.subscribe(() => this._applySettings());
    }

    this._loadManifest();
  }

  // Switch to a category. Idempotent within the same category while it
  // is already playing. A new category crossfades from the old one.
  play(category) {
    if (SettingsStore.get().musicEnabled === false) {
      this.category = category;
      // A queued play() from before the disable must not be revived by
      // _tryStartPending or a later _loadManifest success.
      this.pendingCategory = null;
      this._stopCurrent();
      return;
    }

    if (this.category === category
        && this.currentAudio
        && !this.currentAudio.paused) {
      return;
    }

    this.category = category;

    if (!this.manifest) {
      // Manifest still loading. Queue and let the load callback start us.
      if (!this.unlocked) this.pendingCategory = category;
      this._loadManifest();
      return;
    }

    if (!this.unlocked) {
      this.pendingCategory = category;
      return;
    }

    this._startCategory(category);
  }

  // Stops whatever is playing and clears the category. Rarely needed —
  // most callers just call play() with a new category to crossfade.
  stop() {
    this.category = null;
    this.pendingCategory = null;
    this._stopCurrent();
  }

  // --- manifest ---------------------------------------------------------

  _loadManifest() {
    if (this.manifestPromise) return this.manifestPromise;

    this.manifestPromise = (async () => {
      try {
        const res = await fetch(MANIFEST_URL.href, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        this.manifest = {
          menu:     Array.isArray(json.menu)     ? json.menu.filter(isAudioFilename)     : [],
          campaign: Array.isArray(json.campaign) ? json.campaign.filter(isAudioFilename) : [],
          battle:   Array.isArray(json.battle)   ? json.battle.filter(isAudioFilename)   : []
        };
        this._tryStartPending();
      } catch (e) {
        // Missing file, bad JSON, or 404 — degrade silently to no music.
        this.manifest = { menu: [], campaign: [], battle: [] };
        console.info(
          '[Music] Could not load music/manifest.json — running silent. ' +
          'Add a manifest listing per-category track filenames.'
        );
      }
      return this.manifest;
    })();

    return this.manifestPromise;
  }

  // Starts playback once both prerequisites are met (manifest loaded AND
  // audio unlocked by a user gesture). Safe to call repeatedly.
  _tryStartPending() {
    if (!this.unlocked || !this.manifest) return;
    // Music off: a queued play() from before the disable must not
    // resurrect playback on the next unlock or manifest load.
    if (SettingsStore.get().musicEnabled === false) {
      this.pendingCategory = null;
      return;
    }
    const cat = this.pendingCategory || this.category;
    if (!cat) return;
    this.pendingCategory = null;
    if (this.currentAudio && this.category === cat && !this.currentAudio.paused) {
      return;
    }
    this._startCategory(cat);
  }

  // --- playback ---------------------------------------------------------

  _startCategory(category) {
    const list = (this.manifest && this.manifest[category]) || [];
    if (list.length === 0) {
      this._stopCurrent();
      return;
    }
    this._playTrack(category, this._pickRandom(list));
  }

  // Random track from the list, avoiding the immediately previous track
  // when the list has more than one entry. Falls back to any track after
  // a few attempts if the RNG keeps picking the same one.
  _pickRandom(list) {
    if (list.length === 1) return list[0];
    let path;
    let attempts = 0;
    do {
      path = list[Math.floor(Math.random() * list.length)];
      attempts++;
    } while (path === this.currentPath && attempts < 8);
    return path;
  }

  _playTrack(category, relativePath) {
    // Manifest entries are bare filenames; the category folder is what
    // disambiguates them. Resolve against music/<category>/ rather than
    // music/ so `"menu2.mp3"` becomes `/music/menu/menu2.mp3`.
    const categoryRoot = new URL(category + '/', MUSIC_ROOT);
    const url = new URL(relativePath, categoryRoot).href;

    const audio = new Audio();
    audio.preload = 'auto';
    audio.loop = false;
    audio.volume = 0;
    audio.src = url;

    // Loop: when a track ends, pick a fresh random one from the same
    // category. The 'ended' event is only trusted if this audio is still
    // the current one — a fast category switch may have replaced it.
    audio.addEventListener('ended', () => {
      if (this.category && this.currentAudio === audio) {
        const list = (this.manifest && this.manifest[this.category]) || [];
        if (list.length > 0) {
          this._playTrack(this.category, this._pickRandom(list));
        }
      }
    });
    audio.addEventListener('error', () => {
      console.warn('[Music] Failed to load:', url, audio.error);
    });

    const old = this.currentAudio;
    this.currentAudio = audio;
    this.currentPath = relativePath;

    if (old) {
      if (old.ended || old.paused) {
        this._disposeAudio(old);
      } else {
        this._fadeOutAndStop(old);
      }
    }

    const promise = audio.play();
    if (promise && typeof promise.then === 'function') {
      promise
        .then(() => {
          // audio.play() resolves asynchronously. If this audio was
          // replaced, stopped, or disabled while the promise was in
          // flight, do NOT fade it back in — currentAudio no longer
          // points at it, so _stopCurrent can never find and mute it
          // again, and an orphan would play forever at whatever volume
          // the fade-in set.
          if (this.currentAudio !== audio) {
            this._disposeAudio(audio);
            return;
          }
          if (SettingsStore.get().musicEnabled === false) {
            this.currentAudio = null;
            this.currentPath = null;
            this._disposeAudio(audio);
            return;
          }
          this._fadeIn(audio);
        })
        .catch(() => {
          // Autoplay blocked — re-arm the gesture unlocker and queue
          // this category so the next click retries cleanly. Skip if
          // the audio has been superseded; the new owner has its own
          // fate and this one must not linger.
          if (this.currentAudio !== audio) {
            this._disposeAudio(audio);
            return;
          }
          console.info('[Music] Playback blocked — retrying on next gesture.');
          this.currentAudio = null;
          this.currentPath = null;
          // Only queue a retry when music is still enabled — otherwise
          // the next gesture would start music despite a disable.
          if (SettingsStore.get().musicEnabled !== false) {
            this.pendingCategory = this.category;
          }
          this.unlocked = false;
          this.gestureBound = false;
          this.init();
          this._disposeAudio(audio);
        });
    } else {
      this._fadeIn(audio);
    }
  }

  // --- settings ---------------------------------------------------------

  _applySettings() {
    const enabled = SettingsStore.get().musicEnabled !== false;

    if (!enabled) {
      if (this.currentAudio) this._stopCurrent();
      // Drop any queued category too — a pending play() from before the
      // toggle would otherwise fire on the next gesture via
      // _tryStartPending and start music despite the disable.
      this.pendingCategory = null;
      return;
    }

    // Live volume update. Writing to audio.volume directly would fight
    // any in-flight fade (the fade's setInterval would keep overriding
    // the value on every tick until it hit its own target), so the
    // timer is cancelled first. The slider then feels immediate whether
    // the track is mid-crossfade or steady.
    if (this.currentAudio && !this.currentAudio.paused) {
      if (this.currentAudio._fadeTimer) {
        clearInterval(this.currentAudio._fadeTimer);
        this.currentAudio._fadeTimer = null;
      }
      this.currentAudio.volume = this._targetVolume();
    }

    // Re-enabled: restart the current category if it was silenced.
    if (this.category && this.unlocked && !this.currentAudio) {
      this._startCategory(this.category);
    }
  }

  _targetVolume() {
    const v = SettingsStore.get().musicVolume;
    return clamp01(typeof v === 'number' ? v : DEFAULT_VOLUME);
  }

  // --- audio unlocking --------------------------------------------------

  _primeAudio() {
    try {
      const silent = new Audio();
      silent.src = SILENT_WAV;
      silent.volume = 0;
      silent.play()
        .then(() => {
          silent.pause();
          silent.src = '';
        })
        .catch(() => { /* ignore — prime is best-effort */ });
    } catch (e) {
      // Never let a prime failure break the gesture handler.
    }
  }

  // --- fades ------------------------------------------------------------

  _fadeIn(audio) {
    this._fade(audio, 0, this._targetVolume(), FADE_MS, null);
  }

  _fadeOutAndStop(audio) {
    this._fade(audio, audio.volume, 0, FADE_MS, () => this._disposeAudio(audio));
  }

  _stopCurrent() {
    const audio = this.currentAudio;
    this.currentAudio = null;
    this.currentPath = null;
    if (audio) this._fadeOutAndStop(audio);
  }

  _disposeAudio(audio) {
    if (audio._fadeTimer) {
      clearInterval(audio._fadeTimer);
      audio._fadeTimer = null;
    }
    try { audio.pause(); } catch (e) { /* already stopped */ }
    try { audio.removeAttribute('src'); audio.load(); } catch (e) { /* released */ }
  }

  // Simple linear fade with a per-tick setInterval. Audio volume is not
  // exposed as a smooth param by all browsers via HTMLAudioElement, so a
  // stepped fade is the portable choice.
  _fade(audio, from, to, ms, onDone) {
    if (!audio) {
      if (onDone) onDone();
      return;
    }
    // Cancel any previous fade on this audio element before starting a
    // new one. Without this, a fade-in landing on a track that is still
    // fading out would leave two setInterval loops fighting over
    // audio.volume — the audible result is crackle. The timer is stored
    // on the audio object so the live-volume path in _applySettings can
    // cancel it too.
    if (audio._fadeTimer) {
      clearInterval(audio._fadeTimer);
      audio._fadeTimer = null;
    }
    const steps = Math.max(1, Math.floor(ms / 40));
    const stepMs = ms / steps;
    let step = 0;
    audio.volume = clamp01(from);
    audio._fadeTimer = setInterval(() => {
      step++;
      const t = step / steps;
      audio.volume = clamp01(from + (to - from) * t);
      if (step >= steps) {
        clearInterval(audio._fadeTimer);
        audio._fadeTimer = null;
        audio.volume = clamp01(to);
        if (onDone) onDone();
      }
    }, stepMs);
  }
}

// Singleton. Callers use MusicManager.play('menu'), MusicManager.init(), etc.
export const MusicManager = new _MusicManager();