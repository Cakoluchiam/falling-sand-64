// Plain DOM slider panel bound to the params object. No framework.
//
// The panel is built from SCHEMA rather than hand-written, so adding a
// parameter never means editing this file. Sliders operate in SI; the unit
// descriptor on each entry handles display, which is what lets flow rate read
// in grams per second while the nozzle reads cubic metres.

import { toDisplay, fromDisplay, values, derived, SAND_PARTICLE_DENSITY } from './params.js';

const RESOLUTION = 1000;

function toSlider(s, si) {
  if (s.logZero && si <= 0) return 0;
  if (s.log) {
    const lo = Math.log(s.minSI), hi = Math.log(s.maxSI);
    const t = (Math.log(Math.max(si, s.minSI)) - lo) / (hi - lo);
    // Position 0 is reserved for the exact zero detent.
    return s.logZero ? 1 + t * (RESOLUTION - 1) : t * RESOLUTION;
  }
  return ((si - s.minSI) / (s.maxSI - s.minSI)) * RESOLUTION;
}

function fromSlider(s, pos) {
  if (s.logZero && pos <= 0) return 0;
  if (s.log) {
    const lo = Math.log(s.minSI), hi = Math.log(s.maxSI);
    const t = s.logZero ? (pos - 1) / (RESOLUTION - 1) : pos / RESOLUTION;
    return Math.exp(lo + t * (hi - lo));
  }
  return s.minSI + (pos / RESOLUTION) * (s.maxSI - s.minSI);
}

// Three significant figures, without exponent notation for anything a person
// would plausibly read off a panel.
function format(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 10000) return (v / 1000).toFixed(1) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toPrecision(2);
  return v.toExponential(1);
}

export function buildPanel(container, schema, vals, onChange) {
  const groups = new Map();
  for (const s of schema) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }

  const unitIndex = new Map();   // key -> selected unit index
  const refresh = [];

  for (const [groupName, items] of groups) {
    const sec = document.createElement('section');
    sec.className = 'group';
    const h = document.createElement('h2');
    h.textContent = groupName;
    sec.appendChild(h);

    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'row';
      // Native title rather than a custom popup: zero dependencies, and it
      // cannot end up positioned off the edge of a 264px panel.
      if (s.help) row.title = `${s.label}\n\n${s.help}`;
      // Controls whose milestone has not been built yet are dimmed, so the
      // panel does not imply they do something.
      if (s.pending) row.classList.add('pending');

      const label = document.createElement('label');
      label.textContent = s.label;
      row.appendChild(label);

      if (s.type === 'bool') {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!vals[s.key];
        box.addEventListener('change', () => {
          vals[s.key] = box.checked;
          onChange(s.key);
        });
        row.appendChild(box);
        refresh.push(() => { box.checked = !!vals[s.key]; });
      } else {
        unitIndex.set(s.key, 0);

        const out = document.createElement('span');
        out.className = 'value';

        const unit = document.createElement('button');
        unit.type = 'button';
        unit.className = 'unit';
        if (s.units.length < 2) unit.classList.add('fixed');

        const input = document.createElement('input');
        input.type = 'range';
        input.min = 0;
        input.max = RESOLUTION;
        input.step = 1;

        const paint = () => {
          const ui = unitIndex.get(s.key);
          if (s.dynamic) {
            // Display depends on another parameter, so it is recomputed rather
            // than being a fixed scale on the stored value.
            const d = s.dynamic(vals[s.key]);
            out.textContent = format(d.value);
            unit.textContent = d.unit;
          } else {
            out.textContent = format(toDisplay(s, vals[s.key], ui));
            unit.textContent = s.units[ui].unit;
          }
          // Only override the row's description where the button does
          // something; an empty title on a child suppresses the parent's.
          if (s.units.length > 1) unit.title = 'click to change units';
          else unit.removeAttribute('title');
          input.value = toSlider(s, vals[s.key]);
        };

        input.addEventListener('input', () => {
          vals[s.key] = fromSlider(s, Number(input.value));
          onChange(s.key);
        });
        unit.addEventListener('click', () => {
          if (s.units.length < 2) return;
          unitIndex.set(s.key, (unitIndex.get(s.key) + 1) % s.units.length);
          paint();
        });

        row.appendChild(out);
        row.appendChild(unit);
        row.appendChild(input);
        refresh.push(paint);
      }
      sec.appendChild(row);
    }
    container.appendChild(sec);
  }

  // A short derived block. These are consequences of the sliders rather than
  // independent knobs, but they are the numbers that tell you whether the
  // settings mean anything physically -- above all the clump fraction, which
  // can silently sit at zero while the clump sliders look perfectly reasonable.
  const derivedSec = document.createElement('section');
  derivedSec.className = 'group derived';
  const dh = document.createElement('h2');
  dh.textContent = 'Derived';
  derivedSec.appendChild(dh);
  const dpre = document.createElement('pre');
  derivedSec.appendChild(dpre);
  container.appendChild(derivedSec);

  function paintDerived() {
    // Mean volume, not median: volume cubes the size spread, so using the
    // median would overstate the grain count by 72% at default sorting.
    const bucketGrains = values.dropMass / (derived.meanGrainVolume() * SAND_PARTICLE_DENSITY);
    const pourSeconds = derived.dropVolume() / Math.max(values.flowRate, 1e-12);
    const uniform = values.sorting <= 0;
    const grainRange = uniform
      ? `all exactly ${format(values.medianDiameter * 1000)} mm`
      : `${format(derived.minGrainDiameter() * 1000)} – ${format(derived.maxDiameter() * 1000)} mm`;

    // Clumps from the dedicated population.
    const perSec = derived.clumpsPerSecond();
    const clumpMass = derived.clumpVolume() * SAND_PARTICLE_DENSITY * 1000;
    const rate = values.clumpFraction <= 0 || perSec <= 0
      ? 'off'
      : perSec >= 1 ? `${perSec.toFixed(1)}/s` : `one every ${(1 / perSec).toFixed(1)} s`;

    dpre.textContent = [
      `grains     ${grainRange}`,
      `clump      ${format(derived.clumpMetres() * 1000)} mm, ${format(clumpMass)} g`,
      `           ${format(derived.clumpGrains())} grains of sand each`,
      `rate       ${rate}`,
      `breaks to  ${format(derived.minClumpDiameter() * 1000)} mm min` +
        ` (~${format(derived.fragmentsPerClump())} pieces)`,
      `bucket     ${(bucketGrains / 1e6).toFixed(1)}M grains, pours in ${format(pourSeconds)} s`,
      `active layer ${format(derived.activeLayerMetres() * 1000)} mm`,
      `static angle ${derived.staticAngle().toFixed(1)}°`,
    ].join('\n');
  }
  refresh.push(paintDerived);

  // Called after enforceConstraints() rewrites a value behind the user's back,
  // so no slider disagrees with the simulation.
  function syncFromValues() {
    for (const f of refresh) f();
  }

  // Paint once now. Every control renders through the same path it uses for
  // later updates, so there is no separate initial-render code to drift.
  syncFromValues();
  return syncFromValues;
}
