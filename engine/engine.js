/*
 * Rumpus Onboarding Engine — pozíciófüggetlen gamifikációs logika.
 * XP, streak, szintlogika, modul-lezárás/feloldás, localStorage-perzisztencia.
 * Nem tud semmit a felszolgáló/bartender/host tartalomról — azt a
 * /content/<pozíció>/ mappa JSON-jai adják, a shell (app.html) tölti be.
 */
(function (global) {
  "use strict";

  var STORAGE_PREFIX = "rumpus_engine_v1_";

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  /**
   * Egy modul-tartalom JSON-ból megszámolja, hány "elvégezhető egységet"
   * (unit) tartalmaz — ez adja a modul haladás %-át. Egy "read" vagy
   * "checklist-video" vagy "branch-story" lecke 1 egység; egy "creed-cards"
   * / "phrase-pairs" lecke annyi egység, ahány kártya; egy "quiz" lecke
   * annyi, ahány kérdés.
   */
  function countUnitsForContent(content) {
    var total = 0;
    (content.lessons || []).forEach(function (lsn) {
      if (lsn.type === "creed-cards" || lsn.type === "phrase-pairs") {
        total += (lsn.cards || []).length;
      } else if (lsn.type === "quiz") {
        total += (lsn.questions || []).length;
      } else {
        total += 1;
      }
    });
    return total;
  }

  /** Egy lecke teljes elérhető XP-je (ellenőrzésre / kijelzésre). */
  function lessonMaxXp(lsn) {
    if (lsn.type === "creed-cards" || lsn.type === "phrase-pairs") {
      return (lsn.cards || []).reduce(function (sum, c) { return sum + (c.xp || 0); }, 0);
    }
    if (lsn.type === "branch-story") {
      var m = lsn.xpMap || {};
      return Math.max(m.good || 0, m.neutral || 0, m.bad || 0);
    }
    return lsn.xp || 0;
  }

  function Engine(position) {
    this.position = position;
    this.storageKey = STORAGE_PREFIX + position;
    this.modulesMeta = null;
    this.moduleUnitCounts = {};
    this.state = this._loadState();
    this._touchStreak();
  }

  Engine.prototype._loadState = function () {
    var defaults = { xp: 0, streak: { lastActiveDate: null, count: 0 }, modules: {} };
    try {
      var raw = localStorage.getItem(this.storageKey);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          defaults.xp = parsed.xp || 0;
          defaults.streak = parsed.streak || defaults.streak;
          defaults.modules = parsed.modules || {};
        }
      }
    } catch (e) { /* private mode / blocked storage: fall back to in-memory defaults */ }
    return defaults;
  };

  Engine.prototype._save = function () {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.state)); } catch (e) {}
    // PHASE 2 HOOK: itt lehet majd bekötni a csapatos élő szinkront (pl. egy
    // Google Sheet mögötti Apps Script webhookot), amikor a pilot egyfelhasználós
    // fázisból átlépünk a teljes csapatra. Lásd README a repo gyökerében.
    if (typeof this.onChange === "function") this.onChange();
  };

  Engine.prototype._touchStreak = function () {
    var today = todayStr();
    var s = this.state.streak;
    if (s.lastActiveDate === today) {
      // ma már számoltuk
    } else if (s.lastActiveDate) {
      var prev = new Date(s.lastActiveDate + "T00:00:00");
      var now = new Date(today + "T00:00:00");
      var diffDays = Math.round((now - prev) / 86400000);
      s.count = diffDays === 1 ? (s.count || 0) + 1 : 1;
      s.lastActiveDate = today;
    } else {
      s.count = 1;
      s.lastActiveDate = today;
    }
    this._save();
  };

  Engine.prototype.setModulesMeta = function (meta) { this.modulesMeta = meta; };

  Engine.prototype.registerModuleContent = function (moduleId, content) {
    this.moduleUnitCounts[moduleId] = countUnitsForContent(content);
  };

  Engine.prototype._moduleState = function (moduleId) {
    if (!this.state.modules[moduleId]) this.state.modules[moduleId] = { units: {} };
    if (!this.state.modules[moduleId].units) this.state.modules[moduleId].units = {};
    return this.state.modules[moduleId];
  };

  Engine.prototype.isUnitDone = function (moduleId, unitId) {
    var ms = this._moduleState(moduleId);
    return !!(ms.units[unitId] && ms.units[unitId].done);
  };

  /** Egy egység (kártya, kérdés, olvasó-lecke, branch-story, checklist)
   *  teljesítése. Idempotens: már kész egységre nem ad újra XP-t.
   *  Visszaadja, hogy ténylegesen most történt-e a teljesítés. */
  Engine.prototype.completeUnit = function (moduleId, unitId, xpAmount) {
    var ms = this._moduleState(moduleId);
    if (ms.units[unitId] && ms.units[unitId].done) return false;
    ms.units[unitId] = { done: true, xp: xpAmount || 0 };
    this.state.xp += xpAmount || 0;
    this._save();
    return true;
  };

  Engine.prototype.moduleTotalUnits = function (moduleId) { return this.moduleUnitCounts[moduleId] || 0; };

  Engine.prototype.moduleDoneUnits = function (moduleId) {
    var ms = this._moduleState(moduleId);
    var n = 0;
    Object.keys(ms.units).forEach(function (k) { if (ms.units[k].done) n++; });
    return n;
  };

  Engine.prototype.modulePercent = function (moduleId) {
    var total = this.moduleTotalUnits(moduleId);
    if (!total) return 0;
    return Math.round((this.moduleDoneUnits(moduleId) / total) * 100);
  };

  Engine.prototype.moduleXp = function (moduleId) {
    var ms = this._moduleState(moduleId);
    var sum = 0;
    Object.keys(ms.units).forEach(function (k) { if (ms.units[k].done) sum += ms.units[k].xp || 0; });
    return sum;
  };

  Engine.prototype.isModuleUnlocked = function (moduleId) {
    if (!this.modulesMeta) return false;
    var meta = null;
    for (var i = 0; i < this.modulesMeta.modules.length; i++) {
      if (this.modulesMeta.modules[i].id === moduleId) { meta = this.modulesMeta.modules[i]; break; }
    }
    if (!meta) return false;
    if (!meta.unlockAfter) return true;
    return this.modulePercent(meta.unlockAfter) >= 100;
  };

  Engine.prototype.overallPercent = function () {
    if (!this.modulesMeta) return 0;
    var doneTotal = 0, allTotal = 0, self = this;
    this.modulesMeta.modules.forEach(function (m) {
      allTotal += self.moduleTotalUnits(m.id);
      doneTotal += self.moduleDoneUnits(m.id);
    });
    if (!allTotal) return 0;
    return Math.round((doneTotal / allTotal) * 100);
  };

  /** A ti saját szóhasználatotok: 50% követő / 75% támogatott
   *  önállóság / 100% stabil működés. null, ha még 50% alatt van. */
  Engine.prototype.levelLabel = function () {
    var p = this.overallPercent();
    if (p >= 100) return "Stabil működés";
    if (p >= 75) return "Támogatott önállóság";
    if (p >= 50) return "Követő";
    return null;
  };

  Engine.prototype.streakCount = function () { return this.state.streak.count || 0; };
  Engine.prototype.totalXp = function () { return this.state.xp || 0; };

  // -- PHASE 2 HOOK (inert a pilotban) ---------------------------------
  // Amikor több felhasználó lesz (csapatos rollout, negyedéves
  // szintfenntartó teszt), egy leaderboard-nézet ide fog bekötni: minden
  // felhasználó neve + overallPercent() + totalXp() egy megosztott
  // adattárból (pl. Google Sheet webhook vagy egy `db` képességű
  // Artifact). A pilot fázisban ez a funkció szándékosan nincs meghívva.
  Engine.prototype.getLeaderboardStub = function () {
    return { enabled: false, entries: [] };
  };

  global.RumpusEngine = {
    Engine: Engine,
    countUnitsForContent: countUnitsForContent,
    lessonMaxXp: lessonMaxXp,
    esc: esc,
    el: el,
    qs: qs,
    qsa: qsa
  };
})(window);
