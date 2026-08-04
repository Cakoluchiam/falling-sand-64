// Plain DOM slider panel bound to the params object. No framework.
//
// The panel is built from SCHEMA rather than hand-written, so adding a
// parameter never means editing this file. There is no measurement readout in
// v1 by request, which makes these sliders the only instrument for the
// project's question -- so the panel covers every parameter rather than a
// curated subset.

const RESOLUTION = 1000;

function toSlider(s, value) {
  if (s.logZero && value <= 0) return 0;
  if (s.log) {
    const lo = Math.log(s.min), hi = Math.log(s.max);
    const t = (Math.log(Math.max(value, s.min)) - lo) / (hi - lo);
    // Position 0 is reserved for the exact zero detent.
    return s.logZero ? 1 + t * (RESOLUTION - 1) : t * RESOLUTION;
  }
  return ((value - s.min) / (s.max - s.min)) * RESOLUTION;
}

function fromSlider(s, pos) {
  if (s.logZero && pos <= 0) return 0;
  if (s.log) {
    const lo = Math.log(s.min), hi = Math.log(s.max);
    const t = s.logZero ? (pos - 1) / (RESOLUTION - 1) : pos / RESOLUTION;
    return Math.exp(lo + t * (hi - lo));
  }
  return s.min + (pos / RESOLUTION) * (s.max - s.min);
}

function format(value) {
  if (value === 0) return '0';
  const a = Math.abs(value);
  if (a >= 100) return value.toFixed(0);
  if (a >= 1) return value.toFixed(2);
  if (a >= 0.01) return value.toFixed(3);
  return value.toExponential(1);
}

export function buildPanel(container, schema, values, onChange) {
  const groups = new Map();
  for (const s of schema) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }

  const refresh = [];

  for (const [groupName, items] of groups) {
    const fs = document.createElement('section');
    fs.className = 'group';
    const h = document.createElement('h2');
    h.textContent = groupName;
    fs.appendChild(h);

    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'row';

      const label = document.createElement('label');
      label.textContent = s.label;
      row.appendChild(label);

      if (s.type === 'bool') {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!values[s.key];
        box.addEventListener('change', () => {
          values[s.key] = box.checked;
          onChange(s.key);
        });
        row.appendChild(box);
        refresh.push(() => { box.checked = !!values[s.key]; });
      } else {
        const out = document.createElement('span');
        out.className = 'value';
        out.textContent = format(values[s.key]);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = 0;
        input.max = RESOLUTION;
        input.step = 1;
        input.value = toSlider(s, values[s.key]);
        input.addEventListener('input', () => {
          values[s.key] = fromSlider(s, Number(input.value));
          out.textContent = format(values[s.key]);
          onChange(s.key);
        });

        row.appendChild(out);
        row.appendChild(input);
        refresh.push(() => {
          input.value = toSlider(s, values[s.key]);
          out.textContent = format(values[s.key]);
        });
      }
      fs.appendChild(row);
    }
    container.appendChild(fs);
  }

  // Called after enforceConstraints() rewrites a value behind the user's back,
  // so the slider does not disagree with the simulation.
  return function syncFromValues() {
    for (const f of refresh) f();
  };
}
