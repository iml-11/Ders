// Ders Asistanı – uygulama mantığı
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------- Depolama ----------
  // Ayarlar localStorage'da; dersler (görseller büyük olabileceği için) IndexedDB'de.
  const SETTINGS_KEY = 'ders.settings.v1';
  const THEME_KEY = 'ders.theme';

  const defaultSettings = {
    provider: 'gemini',
    apiKey: '',
    model: AI.PROVIDERS.gemini.models[0],
    baseUrl: '',
    maxTokens: 16000,
    language: 'Türkçe',
    style: '',
    keys: {}, // sağlayıcı başına anahtar hafızası
    models: {},
    baseUrls: {},
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
    } catch (_) {
      return { ...defaultSettings };
    }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) { /* yok say */ }
  }

  const db = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('ders-asistani', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => { this._db = req.result; resolve(this._db); };
        req.onerror = () => reject(req.error);
      });
    },
    async get(key) {
      const d = await this.open();
      return new Promise((resolve, reject) => {
        const r = d.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async set(key, value) {
      const d = await this.open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  let settings = loadSettings();
  let lessons = [];
  let currentId = null;
  let memoryOnly = false;

  async function loadLessons() {
    try {
      lessons = (await db.get('lessons')) || [];
    } catch (_) {
      memoryOnly = true;
      lessons = [];
      toast('Tarayıcı depolaması kullanılamıyor; dersler sayfa kapanınca kaybolur.');
    }
  }
  let saveTimer = null;
  function persist() {
    if (memoryOnly) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await db.set('lessons', lessons); } catch (e) { toast('Kaydedilemedi: ' + e.message); }
    }, 250);
  }

  const current = () => lessons.find((l) => l.id === currentId);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- Yardımcılar ----------
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Tek bir LaTeX parçasını KaTeX ile HTML'e çevirir
  function renderMath(src) {
    if (!window.katex) return escapeHtml(src);
    let display = false;
    let tex;
    if (src.startsWith('$$')) { display = true; tex = src.slice(2, -2); }
    else if (src.startsWith('\\[')) { display = true; tex = src.slice(2, -2); }
    else if (src.startsWith('\\(')) { tex = src.slice(2, -2); }
    else { tex = src.slice(1, -1); }
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false });
    } catch (_) {
      return escapeHtml(src);
    }
  }

  // Markdown + LaTeX güvenli render
  function renderMarkdown(el, text) {
    const maths = [];
    const protectedText = text.replace(
      /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?![\s\d])[^\n$]+?\$)/g,
      (m) => { maths.push(m); return `@@MATH${maths.length - 1}@@`; }
    );
    let html = window.marked ? marked.parse(protectedText, { breaks: false, gfm: true }) : escapeHtml(protectedText);
    html = window.DOMPurify ? DOMPurify.sanitize(html) : html;
    html = html.replace(/@@MATH(\d+)@@/g, (_, i) => renderMath(maths[+i]));
    el.innerHTML = html;
    $$('a', el).forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }

  // Akış sırasında render'ı kare başına bir kez yap
  function streamRenderer(el) {
    let pending = null;
    let raf = 0;
    return (text) => {
      pending = text;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderMarkdown(el, pending);
        el.classList.add('cursor');
      });
    };
  }

  function extractJSON(text) {
    let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('Cevapta JSON bulunamadı.');
    t = t.slice(start, end + 1);
    try {
      return JSON.parse(t);
    } catch (_) {
      // Sık görülen hatalar: sondaki virgüller
      return JSON.parse(t.replace(/,\s*([}\]])/g, '$1'));
    }
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function isConfigured() {
    const p = AI.PROVIDERS[settings.provider];
    return !!(p && settings.model && (p.noKey || settings.apiKey || settings.provider === 'custom'));
  }

  // ---------- Promptlar ----------
  function systemPrompt(lesson) {
    const lang = settings.language || 'Türkçe';
    const parts = [
      `Sen ${lesson.level || 'lise'} seviyesindeki bir öğrenciye ders anlatan, sabırlı, samimi ve çok iyi bir öğretmensin.`,
      `Her zaman ${lang} dilinde cevap ver.`,
      settings.style ? `Öğrencinin istediği anlatım tarzı: ${settings.style}.` : '',
      'Aşağıda öğrencinin yüklediği ders notları var. Anlatımını bu notlara dayandır. Konuyu anlamak için gerekli olup notlarda olmayan bilgileri ekleyebilirsin ama bunları "Ek bilgi" olarak belirt. Notlarda hata görürsen nazikçe düzelt.',
      'Biçim: Markdown kullan (başlıklar, listeler, tablolar, kalın yazı). Matematiksel ifadeleri LaTeX ile yaz: satır içinde $...$, ayrı satırda $$...$$.',
      lesson.images?.length ? `Öğrenci ayrıca ${lesson.images.length} adet not fotoğrafı/sayfa görseli ekledi; bunları dikkatlice oku ve notların parçası olarak kullan.` : '',
      '',
      `<ders_notlari baslik="${lesson.title.replace(/"/g, "'")}">`,
      lesson.notes || '(Metin not yok, yalnızca görseller var.)',
      '</ders_notlari>',
    ];
    return parts.filter((p) => p !== null).join('\n');
  }

  const TASKS = {
    lecture: () =>
      'Bu ders notlarını bana baştan sona, gerçek bir öğretmen gibi anlat.\n' +
      '- Önce konunun ne olduğunu ve neden önemli olduğunu 2-3 cümleyle söyle.\n' +
      '- Konuyu mantıklı bölümlere ayır. Her bölümde temel kavramları sade bir dille açıkla, günlük hayattan örnekler ve benzetmeler kullan.\n' +
      '- Formül, tanım veya kural varsa ne anlama geldiğini ve nasıl kullanıldığını örnek bir çözümle adım adım göster.\n' +
      '- Öğrencilerin sık yaptığı hatalara ve karıştırılan kavramlara dikkat çek.\n' +
      '- Uygun yerlerde "🤔 Kendini yokla" diye kısa bir soru sor (cevabını hemen altında spoiler gibi ver: "Cevap: ...").\n' +
      '- En sonda "🧠 Akılda Kalsın" başlığıyla en önemli noktaları madde madde özetle.',
    summary: () =>
      'Bu ders notlarından sınavdan önce tekrar edebileceğim yoğun bir özet çıkar:\n' +
      '1. **Tek paragrafta konu** (en fazla 4 cümle)\n' +
      '2. **Anahtar kavramlar** tablosu (Kavram | Kısa tanım)\n' +
      '3. **Önemli formüller / kurallar** (varsa)\n' +
      '4. **Madde madde ana noktalar**\n' +
      '5. **Sınavda dikkat!** (sık çıkan ve karıştırılan noktalar)',
    quiz: (count, difficulty) =>
      `Bu ders notlarına dayanarak ${difficulty} zorlukta ${count} adet çoktan seçmeli soru hazırla. ` +
      'Her sorunun 4 şıkkı olsun, yalnızca biri doğru olsun, doğru şıkkın yerini karıştır. ' +
      'Sorular ezber yerine anlamayı ölçsün. Her soru için doğru cevabın neden doğru olduğunu (ve gerekirse diğerlerinin neden yanlış olduğunu) kısaca açıkla.\n' +
      'SADECE aşağıdaki biçimde geçerli JSON döndür, başka hiçbir metin yazma:\n' +
      '{"questions":[{"q":"soru metni","options":["A şıkkı","B şıkkı","C şıkkı","D şıkkı"],"answer":0,"explanation":"açıklama"}]}\n' +
      '"answer" doğru şıkkın 0\'dan başlayan sırasıdır. Şık metinlerinin başına "A)" gibi harf koyma.',
    cards: () =>
      'Bu ders notlarından ezber ve tekrar için 12-20 adet bilgi kartı (flashcard) hazırla. ' +
      'Ön yüzde kısa bir soru/kavram, arka yüzde net ve kısa bir cevap olsun.\n' +
      'SADECE aşağıdaki biçimde geçerli JSON döndür, başka hiçbir metin yazma:\n' +
      '{"cards":[{"front":"ön yüz","back":"arka yüz"}]}',
  };

  // ---------- Üretim (tek aktif istek) ----------
  let active = null; // { controller, kind }

  function setBusy(kind, busy) {
    $$('[data-generate]').forEach((b) => { b.disabled = busy; });
    $('#chatSend').disabled = busy;
    $$('[data-stop]').forEach((b) => b.classList.toggle('hidden', !busy));
    if (!busy) active = null;
  }

  async function runAI({ kind, messages, onToken }) {
    if (!isConfigured()) {
      openSettings();
      throw new AI.AIError('Önce bir yapay zeka API\'si bağlamalısın.');
    }
    if (active) throw new AI.AIError('Başka bir işlem sürüyor.');
    const lesson = current();
    const controller = new AbortController();
    active = { controller, kind };
    setBusy(kind, true);
    try {
      return await AI.chat(settings, {
        system: systemPrompt(lesson),
        messages,
        images: lesson.images || [],
        onToken,
        signal: controller.signal,
      });
    } finally {
      setBusy(kind, false);
    }
  }

  function showError(container, err) {
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = err.name === 'AbortError' ? 'Durduruldu.' : '⚠️ ' + err.message;
    container.appendChild(box);
  }

  async function generateText(kind) {
    const lesson = current();
    const out = $(`[data-output="${kind}"]`);
    const status = $(`[data-status="${kind}"]`);
    out.innerHTML = '';
    status.textContent = 'Yazıyor…';
    const render = streamRenderer(out);
    let partial = '';
    try {
      const text = await runAI({
        kind,
        messages: [{ role: 'user', content: TASKS[kind]() }],
        onToken: (_, full) => { partial = full; render(full); },
      });
      lesson.cache[kind] = text;
      lesson.updatedAt = Date.now();
      persist();
      if (currentId !== lesson.id) return;
      requestAnimationFrame(() => { renderMarkdown(out, text); out.classList.remove('cursor'); });
      status.textContent = '';
    } catch (err) {
      if (err.name === 'AbortError' && partial) {
        lesson.cache[kind] = partial;
        persist();
      }
      if (currentId !== lesson.id) return;
      requestAnimationFrame(() => {
        out.classList.remove('cursor');
        if (partial) renderMarkdown(out, partial);
        showError(out, err);
      });
      status.textContent = '';
    }
    updateGenerateLabels();
  }

  async function generateStructured(kind) {
    const lesson = current();
    const area = kind === 'quiz' ? $('#quizArea') : $('#cardsArea');
    const status = $(`[data-status="${kind}"]`);
    area.innerHTML = '';
    status.textContent = 'Hazırlanıyor…';
    const count = $('#quizCount').value;
    const difficulty = $('#quizDifficulty').value;
    try {
      const text = await runAI({
        kind,
        messages: [{ role: 'user', content: kind === 'quiz' ? TASKS.quiz(count, difficulty) : TASKS.cards() }],
        onToken: (_, full) => { status.textContent = `Hazırlanıyor… (${full.length} karakter)`; },
      });
      const data = extractJSON(text);
      if (kind === 'quiz') {
        const qs = (data.questions || []).filter((q) => q && q.q && Array.isArray(q.options) && q.options.length >= 2);
        if (!qs.length) throw new Error('Geçerli soru üretilemedi. Tekrar dene.');
        lesson.cache.quiz = { questions: qs, answers: {} };
      } else {
        const cs = (data.cards || []).filter((c) => c && c.front && c.back);
        if (!cs.length) throw new Error('Geçerli kart üretilemedi. Tekrar dene.');
        lesson.cache.cards = { cards: cs, index: 0 };
      }
      lesson.updatedAt = Date.now();
      persist();
      if (currentId !== lesson.id) return;
      status.textContent = '';
      kind === 'quiz' ? renderQuiz() : renderCards();
    } catch (err) {
      if (currentId !== lesson.id) return;
      status.textContent = '';
      if (err instanceof SyntaxError) err.message = 'Model geçerli JSON döndürmedi. Tekrar dene ya da daha güçlü bir model seç.';
      showError(area, err);
    }
    updateGenerateLabels();
  }

  // ---------- Test ----------
  function renderQuiz() {
    const lesson = current();
    const area = $('#quizArea');
    area.innerHTML = '';
    const quiz = lesson.cache.quiz;
    if (!quiz) {
      area.innerHTML = '<p class="muted">Notlarından çoktan seçmeli bir test oluştur, cevapla ve anında açıklamalı geri bildirim al.</p>';
      return;
    }
    const letters = 'ABCDEFGH';
    quiz.questions.forEach((q, qi) => {
      const box = document.createElement('div');
      box.className = 'quiz-q';
      const h = document.createElement('h3');
      renderMarkdown(h, `${qi + 1}. ${q.q}`);
      box.appendChild(h);
      const chosen = quiz.answers[qi];
      const answer = Number(q.answer);
      q.options.forEach((opt, oi) => {
        const b = document.createElement('button');
        b.className = 'quiz-opt';
        renderMarkdown(b, `**${letters[oi]})** ${String(opt).replace(/^[A-H][).]\s*/, '')}`);
        if (chosen !== undefined) {
          b.disabled = true;
          if (oi === answer) b.classList.add('correct');
          else if (oi === chosen) b.classList.add('wrong');
        }
        b.addEventListener('click', () => {
          quiz.answers[qi] = oi;
          persist();
          renderQuiz();
        });
        box.appendChild(b);
      });
      if (chosen !== undefined && q.explanation) {
        const exp = document.createElement('div');
        exp.className = 'quiz-exp';
        renderMarkdown(exp, (chosen === answer ? '✅ **Doğru!** ' : '❌ **Yanlış.** ') + q.explanation);
        box.appendChild(exp);
      }
      area.appendChild(box);
    });
    const answered = Object.keys(quiz.answers).length;
    const correct = quiz.questions.filter((q, i) => quiz.answers[i] === Number(q.answer)).length;
    const score = document.createElement('div');
    score.className = 'quiz-score';
    score.textContent = answered === quiz.questions.length
      ? `Sonuç: ${correct}/${quiz.questions.length} doğru (%${Math.round((correct / quiz.questions.length) * 100)})`
      : `${answered}/${quiz.questions.length} cevaplandı · ${correct} doğru`;
    area.appendChild(score);
    if (answered === quiz.questions.length) {
      const again = document.createElement('div');
      again.className = 'actions';
      again.style.marginTop = '12px';
      const reset = document.createElement('button');
      reset.className = 'btn ghost small';
      reset.textContent = '↺ Aynı testi tekrar çöz';
      reset.onclick = () => { quiz.answers = {}; persist(); renderQuiz(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      const ask = document.createElement('button');
      ask.className = 'btn ghost small';
      ask.textContent = '💬 Yanlışlarımı açıkla';
      ask.onclick = () => {
        const wrong = quiz.questions
          .map((q, i) => ({ q, i }))
          .filter(({ q, i }) => quiz.answers[i] !== Number(q.answer));
        if (!wrong.length) { toast('Hepsi doğru, tebrikler! 🎉'); return; }
        const txt = 'Testte şu soruları yanlış yaptım. Her biri için konunun ilgili kısmını tekrar, anlaşılır şekilde anlat:\n\n' +
          wrong.map(({ q, i }) => `- Soru: ${q.q}\n  Benim cevabım: ${q.options[quiz.answers[i]]}\n  Doğru cevap: ${q.options[Number(q.answer)]}`).join('\n');
        switchTab('chat');
        sendChat(txt);
      };
      again.append(reset, ask);
      area.appendChild(again);
    }
  }

  // ---------- Kartlar ----------
  function renderCards() {
    const lesson = current();
    const area = $('#cardsArea');
    area.innerHTML = '';
    const deck = lesson.cache.cards;
    if (!deck) {
      area.innerHTML = '<p class="muted">Notlarından çift yüzlü bilgi kartları oluştur. Karta tıklayarak çevir, oklarla geç.</p>';
      return;
    }
    const i = Math.min(deck.index || 0, deck.cards.length - 1);
    const c = deck.cards[i];
    const wrap = document.createElement('div');
    wrap.className = 'fc-wrap';
    const card = document.createElement('button');
    card.className = 'flashcard';
    card.setAttribute('aria-label', 'Kartı çevir');
    const inner = document.createElement('div');
    inner.className = 'fc-inner';
    const front = document.createElement('div');
    front.className = 'fc-face fc-front';
    const back = document.createElement('div');
    back.className = 'fc-face fc-back';
    renderMarkdown(front, c.front);
    renderMarkdown(back, c.back);
    inner.append(front, back);
    card.appendChild(inner);
    card.onclick = () => card.classList.toggle('flipped');

    const nav = document.createElement('div');
    nav.className = 'fc-nav';
    const prev = document.createElement('button');
    prev.className = 'btn ghost';
    prev.textContent = '← Önceki';
    prev.disabled = i === 0;
    prev.onclick = () => { deck.index = i - 1; persist(); renderCards(); };
    const counter = document.createElement('span');
    counter.className = 'muted';
    counter.textContent = `${i + 1} / ${deck.cards.length}`;
    const next = document.createElement('button');
    next.className = 'btn ghost';
    next.textContent = 'Sonraki →';
    next.disabled = i === deck.cards.length - 1;
    next.onclick = () => { deck.index = i + 1; persist(); renderCards(); };
    const shuffle = document.createElement('button');
    shuffle.className = 'btn ghost small';
    shuffle.textContent = '🔀 Karıştır';
    shuffle.onclick = () => {
      for (let k = deck.cards.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [deck.cards[k], deck.cards[j]] = [deck.cards[j], deck.cards[k]];
      }
      deck.index = 0; persist(); renderCards();
    };
    nav.append(prev, counter, next);
    const hint = document.createElement('div');
    hint.className = 'muted small';
    hint.textContent = 'Karta tıkla veya boşluk tuşuna bas: çevir · ← → : geç';
    wrap.append(card, nav, shuffle, hint);
    area.appendChild(wrap);
  }

  document.addEventListener('keydown', (e) => {
    if ($('[data-panel="cards"]').classList.contains('hidden')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const deck = current()?.cache?.cards;
    if (!deck) return;
    if (e.key === 'ArrowRight' && deck.index < deck.cards.length - 1) { deck.index++; renderCards(); }
    else if (e.key === 'ArrowLeft' && deck.index > 0) { deck.index--; renderCards(); }
    else if (e.key === ' ') { e.preventDefault(); $('.flashcard')?.classList.toggle('flipped'); }
  });

  // ---------- Sohbet ----------
  function renderChat() {
    const lesson = current();
    const log = $('#chatLog');
    log.innerHTML = '';
    if (!lesson.chat.length) {
      log.innerHTML = '<div class="chat-empty muted">Dersle ilgili aklına takılan her şeyi sor. Yapay zeka senin notlarını bilerek cevap verir.</div>';
      return;
    }
    lesson.chat.forEach((m) => log.appendChild(chatBubble(m.role, m.content)));
  }

  function chatBubble(role, content) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    if (role === 'user') {
      div.textContent = content;
    } else {
      const md = document.createElement('div');
      md.className = 'md';
      renderMarkdown(md, content);
      div.appendChild(md);
    }
    return div;
  }

  async function sendChat(text) {
    text = text.trim();
    if (!text || active) return;
    const lesson = current();
    const log = $('#chatLog');
    if (!lesson.chat.length) log.innerHTML = '';
    lesson.chat.push({ role: 'user', content: text });
    log.appendChild(chatBubble('user', text));
    const bubble = chatBubble('assistant', '');
    const md = $('.md', bubble);
    md.textContent = '…';
    log.appendChild(bubble);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
    const render = streamRenderer(md);
    let partial = '';
    try {
      const reply = await runAI({
        kind: 'chat',
        messages: lesson.chat.map((m) => ({ role: m.role, content: m.content })),
        onToken: (_, full) => { partial = full; render(full); },
      });
      lesson.chat.push({ role: 'assistant', content: reply });
      lesson.updatedAt = Date.now();
      persist();
      requestAnimationFrame(() => { renderMarkdown(md, reply); md.classList.remove('cursor'); });
    } catch (err) {
      if (err.name === 'AbortError' && partial) {
        lesson.chat.push({ role: 'assistant', content: partial });
        persist();
        requestAnimationFrame(() => { renderMarkdown(md, partial); md.classList.remove('cursor'); });
      } else {
        // Başarısız soruyu geri al ki sohbet sırası bozulmasın
        lesson.chat.pop();
        requestAnimationFrame(() => {
          md.classList.remove('cursor');
          md.innerHTML = '';
          showError(md, err);
        });
        if (!$('#chatInput').value) $('#chatInput').value = text;
      }
    }
  }

  // ---------- Görünümler ----------
  function renderLessonList() {
    const ul = $('#lessonList');
    ul.innerHTML = '';
    if (!lessons.length) {
      ul.innerHTML = '<li class="muted small" style="padding:8px 10px">Henüz ders yok.</li>';
      return;
    }
    [...lessons].sort((a, b) => b.updatedAt - a.updatedAt).forEach((l) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = l.id === currentId ? 'active' : '';
      b.innerHTML = `${escapeHtml(l.title)}<span class="date">${formatDate(l.updatedAt)} · ${escapeHtml(l.level || '')}</span>`;
      b.onclick = () => { openLesson(l.id); closeSidebar(); };
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  function showNewView() {
    if (active) active.controller.abort();
    currentId = null;
    $('#newView').classList.remove('hidden');
    $('#lessonView').classList.add('hidden');
    renderLessonList();
    closeSidebar();
  }

  function updateGenerateLabels() {
    const l = current();
    if (!l) return;
    $('[data-generate="lecture"]').textContent = l.cache.lecture ? '↻ Yeniden anlat' : 'Dersi anlat';
    $('[data-generate="summary"]').textContent = l.cache.summary ? '↻ Yeniden özetle' : 'Özet çıkar';
    $('[data-generate="quiz"]').textContent = l.cache.quiz ? '↻ Yeni test' : 'Test oluştur';
    $('[data-generate="cards"]').textContent = l.cache.cards ? '↻ Yeni kartlar' : 'Bilgi kartları oluştur';
  }

  function openLesson(id, tab) {
    if (active) active.controller.abort();
    currentId = id;
    const l = current();
    if (!l) return showNewView();
    $('#newView').classList.add('hidden');
    $('#lessonView').classList.remove('hidden');
    $('#lvTitle').textContent = l.title;
    const words = (l.notes || '').split(/\s+/).filter(Boolean).length;
    $('#lvMeta').textContent = `${l.level} · ${words.toLocaleString('tr-TR')} kelime${l.images?.length ? ` · ${l.images.length} görsel` : ''} · ${formatDate(l.createdAt)}`;

    ['lecture', 'summary'].forEach((k) => {
      const out = $(`[data-output="${k}"]`);
      out.classList.remove('cursor');
      if (l.cache[k]) renderMarkdown(out, l.cache[k]);
      else out.innerHTML = '';
      $(`[data-status="${k}"]`).textContent = '';
    });
    $('[data-status="quiz"]').textContent = '';
    $('[data-status="cards"]').textContent = '';
    renderQuiz();
    renderCards();
    renderChat();
    renderNotesEditor();
    updateGenerateLabels();
    renderLessonList();
    switchTab(tab || 'lecture');
    window.scrollTo({ top: 0 });
  }

  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  }

  function renderNotesEditor() {
    const l = current();
    $('#notesEditor').value = l.notes || '';
    $('#notesStatus').textContent = '';
    const grid = $('#notesImages');
    grid.innerHTML = '';
    (l.images || []).forEach((src, i) => {
      const fig = document.createElement('figure');
      const img = document.createElement('img');
      img.src = src;
      img.alt = `Not görseli ${i + 1}`;
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Görseli kaldır';
      del.onclick = () => { l.images.splice(i, 1); persist(); renderNotesEditor(); };
      fig.append(img, del);
      grid.appendChild(fig);
    });
  }

  // ---------- Dosya işleme ----------
  async function processFiles(fileList, chipsEl) {
    const result = { text: [], images: [], names: [] };
    for (const file of fileList) {
      const li = document.createElement('li');
      li.textContent = `⏳ ${file.name}`;
      chipsEl?.appendChild(li);
      try {
        const r = await Files.extractFile(file);
        if (r.text) result.text.push(`### ${file.name}\n${r.text}`);
        result.images.push(...(r.images || []));
        result.names.push(file.name);
        li.textContent = `✓ ${file.name}${r.note ? ` (${r.note})` : ''}`;
      } catch (e) {
        li.textContent = `✗ ${file.name}: ${e.message}`;
        li.className = 'err';
      }
    }
    return result;
  }

  const pending = { text: [], images: [], names: [] };

  async function handleNewFiles(files) {
    if (!files.length) return;
    $('#newStatus').textContent = 'Dosyalar okunuyor…';
    const r = await processFiles(files, $('#fileChips'));
    pending.text.push(...r.text);
    pending.images.push(...r.images);
    pending.names.push(...r.names);
    if (!$('#lessonTitle').value && r.names[0]) {
      $('#lessonTitle').value = r.names[0].replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    }
    $('#newStatus').textContent = '';
  }

  async function createLesson() {
    const pasted = $('#lessonNotes').value.trim();
    const notes = [...pending.text, pasted].filter(Boolean).join('\n\n');
    if (!notes && !pending.images.length) {
      toast('Önce not yükle ya da yapıştır.');
      return;
    }
    const title = $('#lessonTitle').value.trim() || `Ders ${lessons.length + 1}`;
    const lesson = {
      id: uid(),
      title,
      level: $('#lessonLevel').value,
      notes,
      images: [...pending.images],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cache: {},
      chat: [],
    };
    lessons.push(lesson);
    persist();
    // formu sıfırla
    pending.text = []; pending.images = []; pending.names = [];
    $('#lessonNotes').value = '';
    $('#lessonTitle').value = '';
    $('#fileChips').innerHTML = '';
    openLesson(lesson.id, 'lecture');
    if (isConfigured()) generateText('lecture');
    else {
      toast('Ders kaydedildi. Anlatım için önce bir yapay zeka API\'si bağla.');
      openSettings();
    }
  }

  // ---------- Ayarlar ----------
  function fillProviderFields(providerKey) {
    const p = AI.PROVIDERS[providerKey];
    $('#sProviderHint').textContent = p.hint || '';
    $('#sKeyField').classList.toggle('hidden', !!p.noKey);
    $('#sKey').value = settings.keys[providerKey] ?? (settings.provider === providerKey ? settings.apiKey : '');
    $('#sModel').value = settings.models[providerKey] || (settings.provider === providerKey ? settings.model : '') || p.models[0] || '';
    $('#sBaseUrl').value = settings.baseUrls[providerKey] || p.baseUrl;
    $('#sModelList').innerHTML = p.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
    $('#sTestStatus').textContent = '';
  }

  function openSettings() {
    const sel = $('#sProvider');
    sel.innerHTML = Object.entries(AI.PROVIDERS)
      .map(([k, p]) => `<option value="${k}">${escapeHtml(p.name)}</option>`).join('');
    sel.value = settings.provider;
    fillProviderFields(settings.provider);
    $('#sLanguage').value = settings.language;
    $('#sMaxTokens').value = settings.maxTokens;
    $('#sStyle').value = settings.style;
    $('#settingsDialog').showModal();
  }

  function readSettingsForm() {
    const provider = $('#sProvider').value;
    const p = AI.PROVIDERS[provider];
    const baseUrl = $('#sBaseUrl').value.trim();
    return {
      ...settings,
      provider,
      apiKey: $('#sKey').value.trim(),
      model: $('#sModel').value.trim(),
      baseUrl: baseUrl === p.baseUrl ? '' : baseUrl,
      language: $('#sLanguage').value.trim() || 'Türkçe',
      maxTokens: Math.max(256, Number($('#sMaxTokens').value) || 16000),
      style: $('#sStyle').value.trim(),
    };
  }

  function commitSettings(s) {
    s.keys = { ...s.keys, [s.provider]: s.apiKey };
    s.models = { ...s.models, [s.provider]: s.model };
    s.baseUrls = { ...s.baseUrls, [s.provider]: s.baseUrl };
    settings = s;
    saveSettings(settings);
    updateBadge();
  }

  function updateBadge() {
    const b = $('#providerBadge');
    if (isConfigured()) {
      b.textContent = `${AI.PROVIDERS[settings.provider].name.split(' (')[0]} · ${settings.model}`;
      b.classList.add('ok');
    } else {
      b.textContent = 'API bağlı değil';
      b.classList.remove('ok');
    }
  }

  async function testConnection() {
    const s = readSettingsForm();
    const st = $('#sTestStatus');
    st.textContent = 'Deneniyor…';
    try {
      const reply = await AI.chat({ ...s, maxTokens: Math.min(s.maxTokens, 1024) }, {
        system: `Kısa cevap ver. Dil: ${s.language}.`,
        messages: [{ role: 'user', content: 'Merhaba! Bağlantı testi: tek cümleyle kendini tanıt.' }],
      });
      st.textContent = '✅ Çalışıyor: ' + reply.trim().slice(0, 140);
    } catch (e) {
      st.textContent = '❌ ' + e.message;
    }
  }

  // ---------- Kenar çubuğu (mobil) ----------
  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#backdrop').classList.remove('show');
  }

  // ---------- Tema ----------
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }

  // ---------- Olaylar ----------
  function bind() {
    $('#newLessonBtn').onclick = showNewView;
    $('#settingsBtn').onclick = openSettings;
    $('#providerBadge').onclick = openSettings;
    $('#menuBtn').onclick = () => {
      $('#sidebar').classList.toggle('open');
      $('#backdrop').classList.toggle('show');
    };
    $('#backdrop').onclick = closeSidebar;

    $('#themeBtn').onclick = () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
        (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
      const next = isDark ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* yok say */ }
    };

    // Yeni ders
    const dz = $('#dropzone');
    dz.onclick = () => $('#fileInput').click();
    dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } };
    $('#fileInput').onchange = async (e) => { await handleNewFiles([...e.target.files]); e.target.value = ''; };
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => handleNewFiles([...e.dataTransfer.files]));
    $('#createLessonBtn').onclick = createLesson;

    // Sekmeler
    $$('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });

    // Üretim butonları
    $$('[data-generate]').forEach((b) => {
      b.onclick = () => {
        const kind = b.dataset.generate;
        if (kind === 'quiz' || kind === 'cards') generateStructured(kind);
        else generateText(kind);
      };
    });
    $$('[data-stop]').forEach((b) => { b.onclick = () => active?.controller.abort(); });

    // Sohbet
    $('#chatForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('#chatInput').value;
      $('#chatInput').value = '';
      sendChat(v);
    };
    $('#chatInput').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $('#chatForm').requestSubmit();
      }
    };
    $$('#quickPrompts .chip').forEach((c) => { c.onclick = () => sendChat(c.textContent); });
    $('#clearChatBtn').onclick = () => {
      if (!current()?.chat.length || !confirm('Bu dersin sohbet geçmişi silinsin mi?')) return;
      current().chat = [];
      persist();
      renderChat();
    };

    // Notlar
    $('#saveNotesBtn').onclick = () => {
      const l = current();
      l.notes = $('#notesEditor').value;
      l.updatedAt = Date.now();
      persist();
      $('#notesStatus').textContent = '✓ Kaydedildi';
      openLesson(l.id, 'notes');
    };
    $('#addFileInput').onchange = async (e) => {
      const l = current();
      $('#notesStatus').textContent = 'Dosyalar okunuyor…';
      const r = await processFiles([...e.target.files]);
      e.target.value = '';
      if (r.text.length) l.notes = [l.notes, ...r.text].filter(Boolean).join('\n\n');
      if (r.images.length) l.images = [...(l.images || []), ...r.images];
      l.updatedAt = Date.now();
      persist();
      openLesson(l.id, 'notes');
      $('#notesStatus').textContent = `✓ ${r.names.length} dosya eklendi`;
    };

    // Ders işlemleri
    $('#renameBtn').onclick = () => {
      const l = current();
      const t = prompt('Yeni ad:', l.title);
      if (t && t.trim()) { l.title = t.trim(); l.updatedAt = Date.now(); persist(); openLesson(l.id); }
    };
    $('#deleteBtn').onclick = () => {
      const l = current();
      if (!confirm(`"${l.title}" silinsin mi? Bu geri alınamaz.`)) return;
      lessons = lessons.filter((x) => x.id !== l.id);
      persist();
      showNewView();
    };

    // Yedekleme
    $('#exportBtn').onclick = () => {
      const blob = new Blob([JSON.stringify({ version: 1, lessons }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ders-asistani-yedek-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('#importInput').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const incoming = Array.isArray(data) ? data : data.lessons;
        if (!Array.isArray(incoming)) throw new Error('Geçersiz yedek dosyası');
        let added = 0;
        for (const l of incoming) {
          if (!l || !l.id || lessons.some((x) => x.id === l.id)) continue;
          lessons.push({ cache: {}, chat: [], images: [], ...l });
          added++;
        }
        persist();
        renderLessonList();
        toast(`${added} ders geri yüklendi.`);
      } catch (err) {
        toast('Yedek okunamadı: ' + err.message);
      }
    };

    // Ayarlar diyalogu
    $('#sProvider').onchange = (e) => fillProviderFields(e.target.value);
    $('#sKeyToggle').onclick = () => {
      const k = $('#sKey');
      k.type = k.type === 'password' ? 'text' : 'password';
      $('#sKeyToggle').textContent = k.type === 'password' ? 'Göster' : 'Gizle';
    };
    $('#sTest').onclick = testConnection;
    $('#sSave').onclick = () => {
      commitSettings(readSettingsForm());
      $('#settingsDialog').close();
      toast(isConfigured() ? 'Ayarlar kaydedildi ✓' : 'Kaydedildi, ancak anahtar/model eksik.');
    };
  }

  // ---------- Başlat ----------
  async function init() {
    try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (_) { /* yok say */ }
    bind();
    updateBadge();
    await loadLessons();
    renderLessonList();
    if (!isConfigured()) {
      setTimeout(() => toast('Başlamak için sağ üstteki ⚙️ ile bir yapay zeka API\'si bağla.', 5000), 400);
    }
  }

  init();
})();
