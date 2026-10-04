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
const equalJson = (a, b) => a && b && typeof a === 'object' && typeof b === 'object' &&
  !Array.isArray(a) && !Array.isArray(b) && Object.keys(a).length === Object.keys(b).length &&
  Object.keys(b).every((key) => a[key] === b[key]);
function validateRows(rows, cases, modelName) {
  if (!Array.isArray(rows) || rows.length !== 9 || !Array.isArray(cases) || cases.length !== 3) {
    throw new Error('Invalid task receipts');
  }
  const seen = new Set();
  for (const row of rows) {
    const identity = `${row.case_id}:${row.repeat}`;
    const testCase = cases.find((item) => item.id === row.case_id);
    if (!labels[row.case_id] || !testCase || seen.has(identity) || ![1, 2, 3].includes(row.repeat) ||
        (modelName && row.model !== modelName) || typeof row.passed !== 'boolean' || typeof row.output !== 'string' ||
        !equalJson(row.expected, testCase.expected) || !Number.isFinite(row.elapsed_s) || row.elapsed_s <= 0 ||
        !Number.isFinite(row.eval_count) || row.eval_count <= 0 ||
        !Number.isFinite(row.eval_duration) || row.eval_duration <= 0) throw new Error('Invalid run');
    seen.add(identity);
    let correct = false;
    try { correct = equalJson(JSON.parse(row.output), row.expected); } catch { /* Invalid JSON fails. */ }
    if (correct !== row.passed) throw new Error('Incorrect scoring receipt');
  }
}
function validate(data) {
  if (data.schema !== 'local-inference-observation.v1' || data.machine_alias !== 'RDNA4-16' ||
      !Array.isArray(data.runs) || data.runs.length !== 9 ||
      !Array.isArray(data.models) || data.models.length !== 1 ||
      !Array.isArray(data.cases) || data.cases.length !== 3) {
    throw new Error('Invalid receipt schema');
  }
  validateRows(data.runs, data.cases, data.models[0].name);
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
const originalReceipt = (async () => {
  try {
    const response = await fetch('results.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('Receipt request failed');
    const data = validate(await response.json());
    render(data);
    return data;
  } catch {
    byId('result-content').hidden = true;
    byId('load-status').textContent = 'Mittauskuittien lataus tai tarkistus epäonnistui. Lataa JSON yllä olevasta linkistä tai lataa sivu uudelleen. Puuttuva tieto ei ole nolla.';
    return null;
  }
})();

const sha256Pattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
function checkedTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('fi-FI', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Helsinki'
  }).format(date) + ' · Helsinki' : 'Tarkistusaika ei saatavilla';
}
function validateFits(data) {
  if (data.schema !== 'model-fit-comparison.v1' || data.machine_alias !== 'RDNA4-16' ||
      !Array.isArray(data.profiles) || data.profiles.length !== 3 ||
      !Array.isArray(data.sessions) || data.sessions.length !== 2) throw new Error('Invalid comparison');
  const names = new Set();
  for (const profile of data.profiles) {
    const session = data.sessions[profile.session_index];
    if (typeof profile.name !== 'string' || names.has(profile.name) || !session ||
        profile.status !== 'completed' || !sha256Pattern.test(profile.manifest_digest) ||
        !sha256Pattern.test(profile.runner_sha256) || profile.runner_sha256 !== session.runner_sha256 ||
        !Number.isFinite(profile.resident_size_bytes) || profile.resident_size_bytes <= 0 ||
        !Number.isFinite(profile.resident_vram_bytes) || profile.resident_vram_bytes < .9 * profile.resident_size_bytes) {
      throw new Error('Invalid fit identity or residency');
    }
    validateRows(profile.runs, session.cases);
    if (profile.correct !== profile.runs.filter((row) => row.passed).length) throw new Error('Invalid aggregate');
    names.add(profile.name);
  }
  return data;
}
function renderFits(data) {
  for (const profile of data.profiles) {
    const row = element('tr');
    const name = element('th', profile.name);
    name.scope = 'row';
    const proof = element('details');
    proof.append(element('summary', 'Näytä 9 vastausta'));
    for (const run of profile.runs) {
      proof.append(element('p', `${labels[run.case_id]} / ${run.repeat} · ${run.passed ? 'Oikein' : 'Väärin'}`),
        element('pre', run.output), element('p', 'Odotettu JSON'), element('pre', JSON.stringify(run.expected, null, 2)));
    }
    proof.append(element('p', 'Mallimanifestin SHA-256'), element('pre', profile.manifest_digest));
    const proofCell = element('td');
    proofCell.append(proof);
    row.append(name, element('td', `${format(profile.resident_vram_bytes / 2 ** 30)} GiB · ${format(100 * profile.resident_vram_bytes / profile.resident_size_bytes, 0)} %`, 'number'),
      element('td', `${profile.correct} / ${profile.runs.length}`, 'number'),
      element('td', `${format(median(profile.runs.map((run) => run.elapsed_s)))} s`, 'number'),
      element('td', format(median(profile.runs.map(decodeRate)), 1), 'number'), proofCell);
    byId('fit-rows').append(row);
  }
  byId('fit-status').textContent = `27 todellista pyyntöä · tarkistettu ${checkedTime(data.checked_at)}`;
}
function validateResearch(data) {
  if (data.schema !== 'decision-model-availability.v1' || !Array.isArray(data.models) || data.models.length !== 2) {
    throw new Error('Invalid research');
  }
  for (const model of data.models) {
    if (model.status !== 'blocked' || model.local_measurements !== null || model.gated !== false ||
        model.license !== 'Apache-2.0' || !revisionPattern.test(model.revision) ||
        !['Cloudflare/clef-flash', 'Cloudflare/clef'].includes(model.repo) ||
        !Number.isFinite(model.safetensors_bytes) || model.safetensors_bytes <= 16 * 2 ** 30 ||
        model.gguf_files !== 0 || !Array.isArray(model.files) || !model.files.length ||
        !model.files.every((file) => Number.isFinite(file.bytes) && file.bytes > 0 && sha256Pattern.test(file.sha256)) ||
        model.files.reduce((sum, file) => sum + file.bytes, 0) !== model.safetensors_bytes) throw new Error('Invalid availability proof');
  }
  return data;
}
function renderResearch(data) {
  for (const model of data.models) {
    const row = element('tr');
    const name = element('th', `${model.name} ${model.parameters_b}B`);
    name.scope = 'row';
    const source = element('td');
    const card = element('a', 'Pinnattu mallikortti');
    card.href = `https://huggingface.co/${model.repo}/blob/${model.revision}/README.md`;
    card.rel = 'noreferrer';
    source.append(card);
    row.append(name, element('td', `Apache 2.0 · avoin · BF16 ${format(model.safetensors_bytes / 2 ** 30)} GiB`),
      element('td', 'Estetty · ei paikallisia tuloksia'),
      element('td', 'Päätöspään säilyttävä kvantisointi ja validoitu AMD-runtime'), source);
    byId('research-rows').append(row);
  }
  byId('research-status').textContent = `2 avointa päätösmallia · lähteet tarkistettu ${checkedTime(data.checked_at)}`;
}
function validateCatalog(data) {
  if (data.schema !== 'upstream-model-catalog.v1' || !revisionPattern.test(data.source_revision) ||
      !Array.isArray(data.entries) || data.entries.length !== 69) throw new Error('Invalid catalog');
  const names = new Set();
  for (const entry of data.entries) {
    if (!/^[A-Za-z0-9_.-]+$/.test(entry.slug) || names.has(entry.slug) ||
        entry.status !== 'catalog-only-not-locally-tested') throw new Error('Invalid catalog entry');
    names.add(entry.slug);
  }
  return data;
}
function renderCatalog(data) {
  for (const entry of data.entries) {
    const item = element('li');
    const link = element('a', entry.slug);
    link.href = `https://developers.cloudflare.com/workers-ai/models/${entry.slug}/`;
    link.rel = 'noreferrer';
    const label = entry.slug === 'qwen3.8-27b'
      ? ' · samanniminen paikallinen 27B mitattu; Cloudflare-version vastaavuutta ei ole todennettu'
      : ['clef', 'clef-flash'].includes(entry.slug)
        ? ' · painosaatavuus selvitetty; ei paikallista inferenssiä'
        : ' · ei paikallisesti testattu tämän mallikortin versiona';
    item.append(link, element('span', label));
    byId('catalog-list').append(item);
  }
  byId('catalog-title').textContent = `Näytä ${data.entries.length} Cloudflare-mallikorttia · ei mittaustuloksia`;
  byId('catalog-status').textContent = `Lähdeluettelo: ${data.entries.length} korttia, ei ${data.entries.length} paikallista testiä · lähteet tarkistettu ${checkedTime(data.checked_at)}`;
}
async function loadExtra(file, validator, renderer, statusId, contentId) {
  try {
    const response = await fetch(file, {cache: 'no-store'});
    if (!response.ok) throw new Error('Data unavailable');
    const data = validator(await response.json());
    renderer(data);
    if (contentId) byId(contentId).hidden = false;
    return data;
  } catch {
    if (contentId) byId(contentId).hidden = true;
    byId(statusId).textContent = 'Aineiston lataus tai tarkistus epäonnistui. Lataa JSON tai lataa sivu uudelleen. Puuttuva tieto ei ole nolla.';
  }
}
const fitReceipt = loadExtra('fits.json', validateFits, renderFits, 'fit-status', 'fit-content');
loadExtra('research.json', validateResearch, renderResearch, 'research-status', 'research-content');
loadExtra('catalog.json', validateCatalog, renderCatalog, 'catalog-status', 'catalog');

// Rankings use verified measured rows, never model names or catalog marketing.
function measuredModels(original, fits) {
  if (!original || !fits) throw new Error('Incomplete ranking receipts');
  const models = [...fits.profiles, {
    name: 'Qwen2.5-Coder 14B Q4_K_M', runs: original.runs,
    resident_vram_bytes: original.models[0].resident_vram_bytes
  }].map((model) => ({
    ...model,
    correct: model.runs.filter((run) => run.passed).length,
    latency: median(model.runs.map((run) => run.elapsed_s)),
    speed: median(model.runs.map(decodeRate))
  }));
  return models.sort((a, b) => b.correct - a.correct || a.latency - b.latency);
}
function taskScore(model, id) {
  return model.runs.filter((run) => run.case_id === id && run.passed).length;
}
function appendTableRow(target, cells, classes = []) {
  const row = element('tr');
  cells.forEach((value, index) => {
    const cell = element(index === 0 ? 'th' : 'td', value, classes[index]);
    if (index === 0) cell.scope = 'row';
    row.append(cell);
  });
  byId(target).append(row);
}
function renderRankings(models) {
  const best = models[0];
  const fastest = [...models].sort((a, b) => b.speed - a.speed)[0];
  const smallest = [...models].sort((a, b) => a.resident_vram_bytes - b.resident_vram_bytes)[0];
  byId('best-pick').append(element('strong', `Näiden kokeiden ykkösvalinta: ${best.name}. `),
    element('span', `${best.correct}/9 oikein · ${format(best.latency)} s / vastaus · ${format(best.speed, 1)} tok/s. Nopein niistä malleista, jotka vastasivat kaikkiin yhdeksään pyyntöön oikein.`));
  const categories = [
    ['Paras valinta', best.name, `${best.correct}/9 · ${format(best.latency)} s`, 'Oikeellisuus ensin; mediaaniviive ratkaisee tasatuloksen. Ei yleinen laatuluokitus.'],
    ['Nopein generointi', fastest.name, `${format(fastest.speed, 1)} tok/s · ${fastest.correct}/9 oikein`, 'Nopeus ei takaa oikeaa vastausta.'],
    ['Pienin GPU-muisti', smallest.name, `${format(smallest.resident_vram_bytes / 2 ** 30)} GiB · ${smallest.correct}/9 oikein`, 'Mallin GPU-residenssi, ei kokonaiskulutus.']
  ];
  for (const [id, title] of Object.entries({'hardware-extraction': 'Poiminta EN', 'finnish-hardware-extraction': 'Poiminta FI', 'storage-aggregation': 'Tarkka levysumma'})) {
    const high = Math.max(...models.map((model) => taskScore(model, id)));
    const winners = models.filter((model) => taskScore(model, id) === high);
    categories.push([title, winners.length === models.length ? 'Kaikki 4 mallia · tasatulos' : winners.map((model) => model.name).join(' + '),
      `${high}/3 oikein`, winners.length > 1 ? 'Oikeellisuuden tasatulos. Katso mallikohtaiset tulokset alta.' : 'Paras vain tässä yksittäisessä tehtävässä.']);
  }
  categories.push(
    ['Koodaus ja agenttityö', 'Ei vielä voittajaa', 'Ei mitattu', 'Coder-nimi ei ole näyttö koodin toimivuudesta.'],
    ['Keskustelu ja RAG', 'Ei vielä voittajaa', 'Ei mitattu', 'Ei keskustelu- tai hakulaadun hyväksyntäkoetta.'],
    ['Kuva ja ääni', 'Ei vielä voittajaa', 'Ei mitattu', 'Malliluettelon saatavuus ei ole paikallinen testitulos.'],
    ['Clef-päätöksenteko', 'Ei vielä voittajaa', 'Ajo estetty', 'Päätöspäätä ei ole ajettu tällä koneella.']
  );
  for (const cells of categories) {
    appendTableRow('category-rows', cells.slice(0, 3));
    byId('category-notes').append(element('li', `${cells[0]}: ${cells[3]}`));
  }
  for (const model of models) {
    appendTableRow('model-rows', [model.name,
      model.correct === 9 ? 'Toimi · kaikki oikein' : 'Toimi · laskuvirheitä',
      `${model.correct} / 9`, `${format(model.latency)} s`, format(model.speed, 1),
      `${format(model.resident_vram_bytes / 2 ** 30)} GiB`], ['', model.correct === 9 ? 'pass' : 'fail', 'number', 'number', 'number', 'number']);
    const scores = ['hardware-extraction', 'finnish-hardware-extraction', 'storage-aggregation'].map((id) => taskScore(model, id));
    appendTableRow('task-matrix', [model.name, ...scores.map((score) => `${score} / 3`)],
      ['', ...scores.map((score) => `number ${score === 3 ? 'pass' : 'fail'}`)]);
  }
  byId('ranking-status').textContent = '4 ajettua mallia · 36 pisteytettyä vastausta · 3 tehtävää · mittaukset 3.–4. lokakuuta 2026';
  byId('ranking-content').hidden = false;
}
Promise.all([originalReceipt, fitReceipt]).then(([original, fits]) => {
  renderRankings(measuredModels(original, fits));
}).catch(() => {
  byId('ranking-content').hidden = true;
  byId('ranking-status').textContent = 'Kokonaisvertailua ei voida varmistaa: mittausaineisto puuttuu tai on virheellinen. Lataa sivu uudelleen tai tarkista JSON-kuitit alempaa. Voittajaa ei arvata puuttuvista tuloksista.';
});
