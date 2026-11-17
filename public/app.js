// CV Intelligence - browser code. Talks only to this app's own /api routes;
// the Anthropic key never reaches the browser. Everything the model returns is
// shown with textContent, never as HTML.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = { code: '', analysis: null, cvText: '', filters: null, costs: {} };

  // ---------- small helpers ----------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function chip(source) {
    var fromCv = source === 'From CV';
    return el('span', { class: 'chip ' + (fromCv ? 'cv' : 'inf'), text: fromCv ? 'From CV' : 'Inferred - check' });
  }
  function showError(node, message) { node.textContent = message; node.hidden = !message; }
  function store(key, value) { try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch (e) {} }
  function load(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
  function fmt(n) { return Number(n).toLocaleString('en-GB'); }

  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({ 'x-access-code': state.code }, options.json ? { 'Content-Type': 'application/json' } : {});
    var res;
    try {
      res = await fetch('/api/' + path, {
        method: 'POST',
        headers: headers,
        body: options.json ? JSON.stringify(options.json) : options.body,
      });
    } catch (e) {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401) { signOut('Your access code was not accepted. Enter it again.'); throw new Error('Access code not accepted.'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // ---------- theme ----------
  $('themeBtn').addEventListener('click', function () {
    var root = document.documentElement;
    var current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('cvi-theme', next); } catch (e) {}
  });

  // ---------- access code ----------
  function showGate(message) {
    $('main').hidden = true; $('gate').hidden = false; $('signOutBtn').hidden = true;
    showError($('gateError'), message || '');
    $('codeInput').focus();
  }
  function showApp() {
    $('gate').hidden = true; $('main').hidden = false; $('signOutBtn').hidden = false;
  }
  function signOut(message) { state.code = ''; store('cvi-code', null); showGate(message); }

  $('gateForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var code = $('codeInput').value.trim();
    if (!code) return showError($('gateError'), 'Enter the access code.');
    state.code = code;
    try {
      await api('check');
      store('cvi-code', code);
      $('codeInput').value = '';
      showApp();
    } catch (err) {
      state.code = '';
      showError($('gateError'), err.message === 'Access code not accepted.' ? 'That code is not right. Check it and try again.' : err.message);
    }
  });
  $('signOutBtn').addEventListener('click', function () { signOut(''); });

  // ---------- file picker ----------
  var drop = $('drop'), fileInput = $('cvFile');
  function describeFile() {
    var f = fileInput.files[0];
    $('fileName').textContent = f ? f.name : 'Choose a PDF or Word CV';
    $('fileMeta').textContent = f ? Math.max(1, Math.round(f.size / 1024)) + ' KB · ready to analyse' : 'or drag it here · up to 10 MB';
  }
  fileInput.addEventListener('change', describeFile);
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });

  // ---------- tabs ----------
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { selectTab(t); });
    t.addEventListener('keydown', function (e) {
      var visible = tabs.filter(function (x) { return !x.hidden; });
      var i = visible.indexOf(t);
      if (e.key === 'ArrowRight') selectTab(visible[(i + 1) % visible.length], true);
      else if (e.key === 'ArrowLeft') selectTab(visible[(i - 1 + visible.length) % visible.length], true);
      else if (e.key === 'Home') selectTab(visible[0], true);
      else if (e.key === 'End') selectTab(visible[visible.length - 1], true);
      else return;
      e.preventDefault();
    });
  });

  // ---------- analyse ----------
  function setLoading(on, text) {
    $('loading').hidden = !on;
    $('loadingText').textContent = text || '';
    $('resultsPanel').setAttribute('aria-busy', String(on));
    $('runBtn').disabled = on;
  }

  $('cvForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    showError($('formError'), '');
    var file = fileInput.files[0];
    if (!file) return showError($('formError'), 'Choose a CV to upload first.');
    if (!/\.(pdf|docx)$/i.test(file.name)) return showError($('formError'), 'Please upload a PDF or a Word (.docx) CV.');

    var form = new FormData();
    form.append('cv', file);
    form.append('jobSpec', $('spec').value);
    form.append('maxSize', $('maxSize').value);
    form.append('location', $('location').value);

    $('emptyState').hidden = true;
    $('results').hidden = true;
    setLoading(true, 'Reading the CV and building the analysis. This usually takes under a minute…');
    try {
      var data = await api('analyse', { body: form });
      state.analysis = data.analysis; state.cvText = data.cvText; state.filters = data.filters;
      state.costs = { analysis: data.usage };
      render(data);
      $('results').hidden = false;
      selectTab($('tab-co'));
      $('headline').setAttribute('tabindex', '-1');
      $('headline').focus();
      findVacancies();
    } catch (err) {
      // Keep the previous results on screen if there were any.
      if (state.analysis) $('results').hidden = false; else $('emptyState').hidden = false;
      showError($('formError'), err.message);
    } finally {
      setLoading(false);
    }
  });

  function render(data) {
    var a = data.analysis;
    var c = a.candidate;
    $('headline').textContent = c.headline;
    $('summary').textContent = c.summary;
    $('initials').textContent = (c.headline || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
    var skills = $('skills'); clear(skills);
    (c.skills || []).forEach(function (s) { skills.appendChild(el('span', { class: 'tag', text: s })); });
    if (c.location && c.location !== 'Not stated') skills.appendChild(el('span', { class: 'tag', text: c.location }));

    renderCompanies(a.targetCompanies, data.filters, data.removed);
    renderSelling(a.sellingPoints);
    renderAchievements(a.achievements);
    renderPitch(a.pitchGuide);
    renderMatch(a.jobMatch);

    var vac = $('vacancies'); clear(vac); $('count-vac').textContent = ''; $('vacAgain').hidden = true;
    $('emailOut').hidden = true; showError($('emailError'), '');
    var list = $('companyList'); clear(list);
    a.targetCompanies.forEach(function (co) { list.appendChild(el('option', { value: co.name })); });
    renderUsage();
  }

  function renderCompanies(items, filters, removed) {
    var where = filters.location ? ' and hire in or near ' + filters.location : '';
    var note = 'Only companies with ' + fmt(filters.maxSize) + ' employees or fewer' + where + ' are shown. Sizes are Claude\'s estimates, not looked up - check them on LinkedIn before calling.';
    if (removed && removed.companies > 0) note += ' ' + removed.companies + ' suggestion' + (removed.companies === 1 ? ' was' : 's were') + ' removed for being too large or having no size estimate.';
    $('coRule').textContent = note;
    $('count-co').textContent = items.length || '';
    var grid = $('companies'); clear(grid);
    if (!items.length) { grid.appendChild(el('p', { class: 'muted', text: 'No companies matched these filters. Try a larger company size or a wider location.' })); return; }
    items.forEach(function (co) {
      var bar = el('i');
      bar.style.setProperty('--w', Math.min(100, (co.approxEmployees / filters.maxSize) * 100) + '%');
      grid.appendChild(el('article', { class: 'card' }, [
        el('div', { class: 'row' }, [el('h3', { text: co.name }), el('span', { class: 'size', text: '~' + fmt(co.approxEmployees) + ' staff' })]),
        el('div', { class: 'bar', 'aria-hidden': 'true' }, [bar]),
        el('p', { class: 'meta', text: [co.sector, co.location].filter(Boolean).join(' · ') }),
        el('p', { text: co.whyFit }),
        el('p', { class: 'meta', text: 'Size is Claude\'s estimate: ' + co.sizeBasis }),
      ]));
    });
  }

  function renderSelling(items) {
    var ul = $('selling'); clear(ul);
    if (!items.length) ul.appendChild(el('li', { class: 'muted', text: 'No selling points could be confirmed from this CV.' }));
    items.forEach(function (p) {
      ul.appendChild(el('li', { class: 'item' }, [
        el('div', { class: 'body' }, [el('strong', { text: p.point }), el('p', { text: p.detail })]),
        chip(p.source),
      ]));
    });
  }

  function renderAchievements(items) {
    var ul = $('achievements'); clear(ul);
    if (!items.length) ul.appendChild(el('li', { class: 'muted', text: 'The CV has no measurable achievements. Ask the candidate for numbers you can use.' }));
    items.forEach(function (a) {
      var body = el('div', { class: 'body' }, [el('p', { text: a.statement })]);
      if (a.cvQuote) body.appendChild(el('p', { class: 'quote', text: 'CV: "' + a.cvQuote + '"' }));
      ul.appendChild(el('li', { class: 'item' }, [el('span', { class: 'fig', text: a.figure || '-' }), body, chip(a.source)]));
    });
  }

  function renderPitch(p) {
    var box = $('pitch'); clear(box);
    if (p.opening) box.appendChild(el('p', { class: 'opening', text: p.opening }));
    var steps = el('div', { class: 'steps' });
    p.steps.forEach(function (s, i) {
      steps.appendChild(el('div', { class: 'step' }, [el('b', { text: String(i + 1) }), el('p', {}, [el('strong', { text: s.title + '. ' }), document.createTextNode(s.detail)])]));
    });
    box.appendChild(steps);
    if (p.objections.length) {
      box.appendChild(el('h3', { class: 'subhead', text: 'Likely objections' }));
      var ul = el('ul', { class: 'clean' });
      p.objections.forEach(function (o) {
        ul.appendChild(el('li', { class: 'item' }, [el('div', { class: 'body' }, [el('strong', { text: '"' + o.objection + '"' }), el('p', { text: o.response })])]));
      });
      box.appendChild(ul);
    }
  }

  function renderMatch(m) {
    var tab = $('tab-match'), box = $('match'); clear(box);
    tab.hidden = !m;
    if (!m) return;
    var ring = el('div', { class: 'ring', role: 'img', 'aria-label': 'Match score ' + m.score + ' out of 100' }, [el('div', { text: m.score + '%' })]);
    ring.style.setProperty('--p', m.score + '%');
    box.appendChild(el('div', { class: 'score' }, [ring, el('div', { class: 'minw0' }, [
      el('h3', { text: m.summary }),
      el('p', { class: 'meta', text: 'The score is Claude\'s judgement against the pasted spec. Use it as a guide, not a verdict.' }),
    ])]));
    function listCard(title, items) {
      var ul = el('ul'); items.forEach(function (x) { ul.appendChild(el('li', { text: x })); });
      return el('div', { class: 'card' }, [el('h3', { text: title }), items.length ? ul : el('p', { class: 'muted', text: 'None' })]);
    }
    box.appendChild(el('div', { class: 'two' }, [listCard('Matches', m.matches), listCard('Gaps to probe', m.gaps), listCard('Questions to ask the candidate', m.questions)]));
  }

  // ---------- vacancies ----------
  async function findVacancies() {
    var a = state.analysis;
    var box = $('vacancies'); clear(box);
    $('vacAgain').hidden = true;
    $('count-vac').textContent = '…';
    box.appendChild(el('div', { class: 'loading', role: 'status' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { text: 'Searching the web for live vacancies. This can take a minute…' })]));
    try {
      var data = await api('vacancies', { json: {
        headline: a.candidate.headline, skills: a.candidate.skills, level: a.candidate.seniority, cvText: state.cvText,
        companies: a.targetCompanies.map(function (c) { return c.name; }),
        maxSize: state.filters.maxSize, location: state.filters.location || (a.candidate.location !== 'Not stated' ? a.candidate.location : ''),
      } });
      state.costs.vacancies = data.usage;
      renderVacancies(data);
    } catch (err) {
      clear(box);
      box.appendChild(el('p', { class: 'error', text: err.message }));
      $('count-vac').textContent = '';
    }
    $('vacAgain').hidden = false;
    renderUsage();
  }
  $('vacAgain').addEventListener('click', findVacancies);

  function renderVacancies(data) {
    var box = $('vacancies'); clear(box);
    $('count-vac').textContent = data.vacancies.length || '0';
    if (!data.vacancies.length) {
      box.appendChild(el('p', { class: 'muted', text: 'No live vacancies matched these filters. Try again, or widen the company size or location.' }));
      return;
    }
    var list = el('div', { class: 'vac-list' });
    data.vacancies.forEach(function (v) {
      var link = el('a', { class: 'vac-link', href: v.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open the posting' });
      list.appendChild(el('article', { class: 'card' }, [
        el('h3', { text: v.title }),
        el('p', { class: 'meta', text: [v.company, v.location, v.posted].filter(Boolean).join(' · ') }),
        v.whySuitable ? el('p', { text: v.whySuitable }) : null,
        link,
        el('p', { class: 'meta', text: new URL(v.url).hostname.replace(/^www\./, '') }),
      ]));
    });
    box.appendChild(list);
  }

  // ---------- email ----------
  $('emailForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var a = state.analysis;
    showError($('emailError'), '');
    $('emailBtn').disabled = true; $('emailBtn').textContent = 'Writing…';
    try {
      var data = await api('email', { json: {
        headline: a.candidate.headline, location: a.candidate.location, cvText: state.cvText,
        sellingPoints: a.sellingPoints, achievements: a.achievements,
        company: $('emCompany').value, managerName: $('emName').value, jobTitle: $('emRole').value,
      } });
      state.costs.email = data.usage;
      $('emailText').textContent = data.email;
      $('emailOut').hidden = false; $('copied').textContent = '';
      renderUsage();
    } catch (err) {
      showError($('emailError'), err.message);
    } finally {
      $('emailBtn').disabled = false; $('emailBtn').textContent = 'Write email';
    }
  });

  $('copyBtn').addEventListener('click', function () {
    var text = $('emailText').textContent;
    function fallback() {
      var range = document.createRange(); range.selectNodeContents($('emailText'));
      var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      $('copied').textContent = 'Selected - press Ctrl+C (or Cmd+C) to copy';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { $('copied').textContent = 'Copied'; }, fallback);
    } else fallback();
  });

  // ---------- usage ----------
  function renderUsage() {
    var parts = [], total = 0, known = true;
    [['analysis', 'Analysis'], ['vacancies', 'Vacancy search'], ['email', 'Email']].forEach(function (p) {
      var u = state.costs[p[0]];
      if (!u) return;
      if (u.cost_usd == null) known = false; else total += u.cost_usd;
      parts.push(p[1] + ' $' + (u.cost_usd == null ? '?' : u.cost_usd.toFixed(3)));
    });
    $('usage').textContent = parts.length ? 'Approximate Claude cost: ' + parts.join(' · ') + (known ? ' · total $' + total.toFixed(3) : '') : '';
  }

  // ---------- start ----------
  var saved = load('cvi-code');
  if (saved) { state.code = saved; showApp(); } else showGate();
})();
