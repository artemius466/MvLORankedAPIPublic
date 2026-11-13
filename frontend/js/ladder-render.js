// MvLO Ranked — shared ladder-scale and tier-list rendering. Pulled out of the
// tier map page so a player profile page can show the exact same "whole
// ladder" view for whichever ELO it is given, not just the signed-in viewer's.
"use strict";
(function () {
  const T = window.MvLOTiers;
  const LADDER = T.ladder();
  const TOTAL = T.totalSpan();
  const BOTTOM = LADDER[0].from;

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function chipSpan(name, size) {
    return `<span style="flex:none;width:${size}px;height:${size}px;background:url('${T.iconUrl(name)}') center/contain no-repeat"></span>`;
  }

  function range(item) {
    return item.open ? item.from + "+" : item.from + " – " + item.to;
  }

  // Where an elo sits along the full ladder, 0-100.
  function scalePct(elo) {
    return Math.max(0, Math.min(100, ((elo - BOTTOM) / TOTAL) * 100));
  }

  function placeOf(elo) {
    for (const tier of LADDER) {
      for (const division of tier.divisions) {
        if (elo <= division.to || division.open) return { tier, division };
      }
    }
    return null;
  }

  // --- the proportional overview bar ----------------------------------------

  function renderScale(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const segments = LADDER.map((tier) => `
      <div style="flex:${tier.span} 1 0;min-width:0;position:relative;border-right:4px solid #17161d;background:${tier.color};display:grid;place-items:center;padding:0 4px">
        <span class="scale-label" style="font:14px 'MarioUI';color:#fff;text-shadow:2px 2px 0 rgba(23,22,29,.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(tier.name.toUpperCase())}</span>
      </div>`).join("");

    const ticks = LADDER.map((tier, i) => `
      <div style="flex:${tier.span} 1 0;min-width:0;position:relative">
        <span style="position:absolute;left:0;transform:translateX(${i === 0 ? "0" : "-50%"});font:13px 'MarioUI';color:#8b7a4e;white-space:nowrap">${tier.from}</span>
        ${tier.open ? `<span class="scale-tick-end" style="position:absolute;right:0;font:13px 'MarioUI';color:#8b7a4e;white-space:nowrap">${tier.from + tier.span}+</span>` : ""}
      </div>`).join("");

    el.innerHTML = `
      <div id="scale-track" style="position:relative">
        <div style="display:flex;height:44px;border:4px solid #17161d;box-shadow:6px 6px 0 rgba(23,22,29,.25);overflow:hidden">${segments}</div>
        <div id="scale-pins" style="position:absolute;inset:0;pointer-events:none"></div>
      </div>
      <div style="display:flex;margin-top:6px;height:18px">${ticks}</div>`;
  }

  // The scale can carry more than one pin at once - each call owns its own
  // `key` rather than there being a single implicit pin. Stacking index lifts
  // each successive pin a bit higher so their labels don't collide when two
  // pins land close together. Pass a null elo to remove that key's pin.
  function renderPin(key, elo, label, color, stackIndex) {
    const track = document.getElementById("scale-pins");
    if (!track) return;
    const id = "scale-pin-" + key;
    let pin = document.getElementById(id);

    if (elo === null || elo === undefined) {
      if (pin) pin.remove();
      return;
    }
    if (!pin) {
      pin = document.createElement("div");
      pin.id = id;
      track.appendChild(pin);
    }
    const top = -30 - (stackIndex || 0) * 26;
    const lineColor = color || "#17161d";
    pin.style.cssText = `position:absolute;top:${top}px;bottom:-10px;left:${scalePct(elo)}%;width:0;pointer-events:none`;
    pin.innerHTML = `
      <div style="position:absolute;top:0;left:0;transform:translateX(-50%);white-space:nowrap;background:${lineColor};color:#fff;text-shadow:2px 2px 0 rgba(23,22,29,.75);font:13px 'MarioUI';padding:3px 7px;border:2px solid #17161d">${esc(label)} · ${esc(elo)}</div>
      <div style="position:absolute;top:24px;bottom:0;left:-2px;width:4px;background:${lineColor}"></div>`;
  }

  // --- tier by tier ---------------------------------------------------------

  // highlights is an array of { place, label, color }, one per caller-defined
  // marker, so a division more than one marker sits in gets both badges.
  // `place` may be null (that marker's position not known yet); such entries
  // are simply skipped.
  function renderList(containerId, highlights) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const marks = (highlights || []).filter((h) => h && h.place);

    // Highest tier first: the map reads as a climb from the bottom of the page.
    el.innerHTML = [...LADDER].reverse().map((tier) => {
      const divisions = [...tier.divisions].reverse().map((division) => {
        const here = marks.filter((h) => h.place.tier.name === tier.name && h.place.division.label === division.label);
        const current = here.length > 0;
        const badges = here.map((h) => `<span style="font:13px 'MarioUI';color:#fff;text-shadow:2px 2px 0 rgba(23,22,29,.75);background:${h.color};border:3px solid #17161d;padding:2px 7px">${esc(h.label)}</span>`).join("");
        return `
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 12px;border:3px solid #17161d;background:${current ? "#fff6e0" : "#fff"}">
            ${chipSpan(tier.name, 22)}
            <span style="font:18px 'MarioUI';color:#17161d;min-width:112px">${esc(division.label)}</span>
            ${badges}
            <span style="margin-left:auto;font:18px 'MarioUI';color:#17161d;white-space:nowrap">${esc(range(division))}</span>
            <span style="flex:none;min-width:74px;text-align:right;font:14px 'MarioUI';color:#8b7a4e;white-space:nowrap">${division.open ? "no cap" : division.to - division.from + 1 + " pts"}</span>
          </div>`;
      }).join("");

      return `
        <div style="border:4px solid #17161d;background:#fdf3d7;box-shadow:6px 6px 0 rgba(23,22,29,.25);border-left-width:14px;border-left-color:${tier.color}">
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:11px 13px;background:${tier.color};border-bottom:4px solid #17161d">
            ${chipSpan(tier.name, 30)}
            <span style="font:24px 'MarioUI';color:#fff;text-shadow:3px 3px 0 #17161d;letter-spacing:1px">${esc(tier.name.toUpperCase())}</span>
            <span style="margin-left:auto;font:18px 'MarioUI';color:#fff;text-shadow:2px 2px 0 #17161d;white-space:nowrap">${esc(range(tier))}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:7px;padding:11px 13px">${divisions}</div>
        </div>`;
    }).join("");
  }

  window.MvLOLadderView = { LADDER, TOTAL, BOTTOM, esc, chipSpan, scalePct, placeOf, renderScale, renderPin, renderList };
})();
