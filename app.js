'use strict';
// The browser is a read-only projection. Model output is always text, never HTML.
const byId = (id) => document.getElementById(id);
const labels = {
  'hardware-extraction': 'Laitteistopoiminta · EN',
  'storage-aggregation': 'Levyjen yhteiskapasiteetti',
  'finnish-hardware-extraction': 'Laitteistopoiminta · FI'
};
const format = (value, digits = 2) => new Intl.NumberFormat('fi-FI', {
  maximumFractionDigits: digits, minimumFractionDigits: digits
}).format(value);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const decodeRate = (row) => row.eval_count / (row.eval_duration / 1e9);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function validate(data) {
  if (data.schema !== 'local-inference-observation.v1' || data.machine_alias !== 'RDNA4-16' ||
      !Array.isArray(data.runs) || data.runs.length !== 9 ||
      !Array.isArray(data.models) || data.models.length !== 1 ||
      !Array.isArray(data.cases) || data.cases.length !== 3) {
    throw new Error('Invalid receipt schema');
  }
  const seen = new Set();
  const equal = (a, b) => a && b && typeof a === 'object' && typeof b === 'object' &&
    Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((key) => a[key] === b[key]);
  for (const row of data.runs) {
    const identity = `${row.case_id}:${row.repeat}`;
    const testCase = data.cases.find((item) => item.id === row.case_id);
    if (!labels[row.case_id] || !testCase || seen.has(identity) || ![1, 2, 3].includes(row.repeat) ||
        row.model !== data.models[0].name || typeof row.passed !== 'boolean' || typeof row.output !== 'string' ||
        !equal(row.expected, testCase.expected) || !Number.isFinite(row.elapsed_s) || row.elapsed_s <= 0 ||
        !Number.isFinite(row.eval_count) || row.eval_count <= 0 ||
        !Number.isFinite(row.eval_duration) || row.eval_duration <= 0) throw new Error('Invalid run');
    seen.add(identity);
    let correct = false;
    try { correct = equal(JSON.parse(row.output), row.expected); } catch { /* Invalid JSON fails. */ }
    if (correct !== row.passed) throw new Error('Incorrect scoring receipt');
  }
  if (!Number.isFinite(data.models[0].resident_vram_bytes) ||
      !/^[a-f0-9]{64}$/.test(data.models[0].manifest_digest) ||
      !/^[a-f0-9]{64}$/.test(data.runtime?.executable_sha256)) throw new Error('Missing identity');
  return data;
}
function render(data) {
  const rows = data.runs;
  let sort = null;
  byId('score').textContent = `${rows.filter((row) => row.passed).length} / ${rows.length}`;
  byId('latency').textContent = `${format(median(rows.map((row) => row.elapsed_s)))} s`;
  byId('decode').textContent = `${format(median(rows.map(decodeRate)), 1)} tok/s`;
  byId('memory').textContent = `${format(data.models[0].resident_vram_bytes / 2 ** 30)} GiB`;
  for (const [id, label] of Object.entries(labels)) {
    const option = element('option', label);
    option.value = id;
    byId('task').append(option);
    const cases = rows.filter((row) => row.case_id === id);
    const correct = cases.filter((row) => row.passed).length;
    const container = element('div', undefined, 'task-bar');
    const heading = element('div', undefined, 'bar-label');
    heading.append(element('span', label), element('strong', `${correct} / ${cases.length}`));
    const bar = element('div', undefined, 'bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = element('span');
    // Measured geometry, not a design token or fabricated progress.
    fill.style.setProperty('--measured-fill', `${100 * correct / cases.length}%`);
    bar.append(fill);
    container.append(heading, bar);
    byId('task-bars').append(container);
  }
  function update() {
    const task = byId('task').value;
    const outcome = byId('outcome').value;
    const search = byId('search').value.trim().toLocaleLowerCase('fi-FI');
    const selected = rows.filter((row) => (task === 'all' || row.case_id === task) &&
      (outcome === 'all' || row.passed === (outcome === 'pass')) &&
      `${row.case_id} ${labels[row.case_id]} ${row.output}`.toLocaleLowerCase('fi-FI').includes(search));
    if (sort) selected.sort((a, b) => sort === 'ascending' ? a.elapsed_s - b.elapsed_s : b.elapsed_s - a.elapsed_s);
    byId('runs').replaceChildren();
    for (const row of selected) {
      const tr = element('tr');
      const name = element('th', `${labels[row.case_id]} / ${row.repeat}`);
      name.scope = 'row';
      const outcomeCell = element('td', row.passed ? 'Oikein' : 'Väärin', row.passed ? 'pass' : 'fail');
      const detailsCell = element('td');
      const details = element('details');
      details.append(element('summary', 'Avaa vastaus'), element('p', 'Mallin vastaus'),
        element('pre', row.output), element('p', 'Odotettu JSON'), element('pre', JSON.stringify(row.expected, null, 2)));
      detailsCell.append(details);
      tr.append(name, outcomeCell, element('td', `${format(row.elapsed_s)} s`, 'number'),
        element('td', format(decodeRate(row), 1), 'number'), detailsCell);
      byId('runs').append(tr);
    }
    byId('count').textContent = `${selected.length} / ${rows.length} ajoa näkyvissä`;
    byId('empty').hidden = selected.length > 0;
  }
  for (const id of ['task', 'outcome', 'search']) byId(id).addEventListener('input', update);
  byId('reset').addEventListener('click', () => {
    byId('task').value = 'all';
    byId('outcome').value = 'all';
    byId('search').value = '';
    update();
  });
  byId('sort').addEventListener('click', () => {
    sort = sort === 'ascending' ? 'descending' : 'ascending';
    byId('latency-header').setAttribute('aria-sort', sort);
    byId('sort').textContent = sort === 'ascending' ? 'Viive ↑' : 'Viive ↓';
    update();
  });
  byId('identity').replaceChildren(element('p', 'Mallimanifestin SHA-256'),
    element('pre', data.models[0].manifest_digest), element('p', 'Ollama-executablen SHA-256'),
    element('pre', data.runtime.executable_sha256));
  update();
  byId('result-content').hidden = false;
  byId('load-status').textContent = '9 mitattua ajoa · 3 tehtävää · yksi testattu GPU-profiili · toinen profiili estetty';
}
(async () => {
  try {
    const response = await fetch('results.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('Receipt request failed');
    const data = validate(await response.json());
    render(data);
  } catch {
    byId('result-content').hidden = true;
    byId('load-status').textContent = 'Mittauskuittien lataus tai tarkistus epäonnistui. Lataa JSON yllä olevasta linkistä tai lataa sivu uudelleen. Puuttuva tieto ei ole nolla.';
  }
})();
