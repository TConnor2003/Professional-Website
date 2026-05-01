// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════
const HP_TITLES = [
  "Philosopher's Stone",
  "Chamber of Secrets",
  "Prisoner of Azkaban",
  "Goblet of Fire",
  "Order of the Phoenix",
  "Half-Blood Prince",
  "Deathly Hallows"
];
 
const HP_FULL_TITLES = [
  "Harry Potter and the Philosopher's Stone",
  "Harry Potter and the Chamber of Secrets",
  "Harry Potter and the Prisoner of Azkaban",
  "Harry Potter and the Goblet of Fire",
  "Harry Potter and the Order of the Phoenix",
  "Harry Potter and the Half-Blood Prince",
  "Harry Potter and the Deathly Hallows"
];
 
// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let books         = [];   // [{title, chapters:[{title,paragraphs[],bookIndex}]}]
let paragraphPool = [];   // shuffled [{text, chapterTitle, bookIndex, bookChapters}]
let score         = 0;
let highScore     = parseInt(localStorage.getItem('hpOracle_hs') || '0', 10);
let currentItem   = null; // current paragraph pool entry
let quizStage     = 'book'; // 'book' | 'chapter'
let answerLocked  = false;
 
// ═══════════════════════════════════════════════════════
// SCREEN MANAGEMENT
// ═══════════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  void el.offsetHeight;
  el.classList.add('active');
}
 
// ═══════════════════════════════════════════════════════
// EPUB LOADING & PARSING
// ═══════════════════════════════════════════════════════
async function initLoad() {
  showScreen('loadingScreen');
  books         = [];
  paragraphPool = [];
 
  let anyFailed = false;
  const failedBooks = [];
 
  // Fetch + parse all 7 books in parallel
  setLoadingBook('Fetching all books simultaneously…');
  const results = await Promise.all(
    Array.from({ length: 7 }, async (_, i) => {
      try {
        const resp = await fetch(`books/book${i + 1}.epub`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const book = await parseEpub(blob, i);
        document.getElementById(`dot${i}`).classList.add('loaded');
        setProgress(Math.round((books.filter(Boolean).length + 1) / 7 * 90));
        return book;
      } catch (err) {
        console.warn(`Failed to load book${i + 1}.epub:`, err);
        anyFailed = true;
        failedBooks.push(`book${i + 1}.epub`);
        document.getElementById(`dot${i}`).style.background = '#f87171';
        return { title: HP_FULL_TITLES[i], chapters: [] };
      }
    })
  );
 
  // Preserve index order (Promise.all guarantees order)
  books = results;
 
  setProgress(100);
 
  // Build paragraph pool
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const chapterTitles = book.chapters.map(c => c.title);
    for (const ch of book.chapters) {
      for (const para of ch.paragraphs) {
        paragraphPool.push({
          text:          para,
          chapterTitle:  ch.title,
          bookIndex:     i,
          bookChapters:  chapterTitles // all chapters of this book
        });
      }
    }
  }
 
  // Deduplicate paragraphs
  const seenTexts = new Set();
  paragraphPool = paragraphPool.filter(p => {
    if (seenTexts.has(p.text)) return false;
    seenTexts.add(p.text); return true;
  });
 
  shuffleArr(paragraphPool);
 
  await sleep(350);
 
  if (paragraphPool.length === 0) {
    document.getElementById('errorMsg').innerHTML =
      `No readable content was found. ${anyFailed ? `Failed to load: <code>${failedBooks.join('</code>, <code>')}</code>.<br><br>` : ''}
      Make sure this page is served via HTTP (e.g. <code>python -m http.server</code>) and the books folder is in the same directory as this file.`;
    showScreen('errorScreen');
    return;
  }
 
  // Start game
  score = 0;
  updateScoreUI();
  showScreen('quizScreen');
  nextQuestion();
}
 
async function parseEpub(blob, bookIndex) {
  const zip = await JSZip.loadAsync(blob);
  const xp  = new DOMParser();
 
  // container.xml → OPF path
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('No container.xml');
  const containerDoc = xp.parseFromString(containerXml, 'application/xml');
  const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('No rootfile');
 
  const opfDir = opfPath.includes('/')
    ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1)
    : '';
 
  // Parse OPF
  const opfXml = await zip.file(opfPath)?.async('text');
  if (!opfXml) throw new Error('No OPF content');
  const opfDoc = xp.parseFromString(opfXml, 'application/xml');
 
  // Manifest
  const manifest = {};
  opfDoc.querySelectorAll('manifest item').forEach(el => {
    manifest[el.getAttribute('id')] = {
      href:       el.getAttribute('href') || '',
      mediaType:  el.getAttribute('media-type') || '',
      properties: el.getAttribute('properties') || ''
    };
  });
 
  // Spine
  const spineIds = [];
  opfDoc.querySelectorAll('spine itemref').forEach(el => {
    const id = el.getAttribute('idref');
    if (id && manifest[id]) spineIds.push(id);
  });
 
  // Chapter title map
  const titleMap = {};
 
  function resolveHref(baseFilePath, relHref) {
    const frag = relHref.split('#')[0];
    if (!frag) return '';
    if (frag.startsWith('/')) return frag.slice(1);
    const parts = baseFilePath.split('/');
    parts.pop();
    for (const seg of frag.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }
 
  // Try EPUB3 nav
  const navEntry = Object.entries(manifest)
    .find(([, m]) => m.properties.includes('nav'));
  if (navEntry) {
    const navFullPath = opfDir + navEntry[1].href;
    const navXml = await zip.file(navFullPath)?.async('text');
    if (navXml) {
      let navDoc;
      try { navDoc = xp.parseFromString(navXml, 'application/xhtml+xml'); }
      catch { navDoc = xp.parseFromString(navXml, 'text/html'); }
      navDoc.querySelectorAll('a[href]').forEach(a => {
        const raw = a.getAttribute('href') || '';
        if (!raw || raw.startsWith('http')) return;
        const resolved = resolveHref(navFullPath, raw);
        const rel = resolved.startsWith(opfDir) ? resolved.slice(opfDir.length) : resolved;
        const title = a.textContent.trim();
        if (rel && title) {
          titleMap[rel] = title;
          titleMap[rel.split('/').pop()] = title;
        }
      });
    }
  }
 
  // EPUB2 NCX fallback
  if (Object.keys(titleMap).length === 0) {
    const ncxEntry = Object.entries(manifest)
      .find(([, m]) => m.mediaType === 'application/x-dtbncx+xml');
    if (ncxEntry) {
      const ncxFullPath = opfDir + ncxEntry[1].href;
      const ncxXml = await zip.file(ncxFullPath)?.async('text');
      if (ncxXml) {
        const ncxDoc = xp.parseFromString(ncxXml, 'application/xml');
        ncxDoc.querySelectorAll('navPoint').forEach(np => {
          const raw   = np.querySelector('content')?.getAttribute('src') || '';
          const label = np.querySelector('navLabel text')?.textContent?.trim() || '';
          if (!raw || !label) return;
          const resolved = resolveHref(ncxFullPath, raw);
          const rel = resolved.startsWith(opfDir) ? resolved.slice(opfDir.length) : resolved;
          if (rel) {
            titleMap[rel] = label;
            titleMap[rel.split('/').pop()] = label;
          }
        });
      }
    }
  }
 
  // Process spine items into chapters
  const chapters = [];
  for (const itemId of spineIds) {
    const item = manifest[itemId];
    if (!item || !item.mediaType.includes('html')) continue;
 
    const itemHref = item.href;
    const fullPath = opfDir + itemHref;
    const basename = itemHref.split('/').pop();
 
    const chapterTitle = titleMap[itemHref] || titleMap[basename] || titleMap[fullPath];
    if (!chapterTitle) continue;
 
    const htmlRaw = await zip.file(fullPath)?.async('text');
    if (!htmlRaw) continue;
 
    let htmlDoc;
    try { htmlDoc = xp.parseFromString(htmlRaw, 'application/xhtml+xml'); }
    catch { htmlDoc = xp.parseFromString(htmlRaw, 'text/html'); }
 
    const seen = new Set();
    const paragraphs = [];
    htmlDoc.querySelectorAll('p').forEach(p => {
      const t = p.textContent.replace(/\s+/g, ' ').trim();
      if (t.length >= 120 && t.length <= 2500 && !seen.has(t)) {
        seen.add(t);
        paragraphs.push(t);
      }
    });
 
    if (paragraphs.length > 0) {
      chapters.push({ title: chapterTitle, paragraphs, bookIndex });
    }
  }
 
  return { title: HP_FULL_TITLES[bookIndex], chapters };
}
 
// ═══════════════════════════════════════════════════════
// QUIZ GAME
// ═══════════════════════════════════════════════════════
function nextQuestion() {
  if (paragraphPool.length === 0) {
    triggerGameOver(null); // completed all passages — won!
    return;
  }
 
  currentItem   = paragraphPool.pop();
  quizStage     = 'book';
  answerLocked  = false;
 
  // Passage
  const pc = document.getElementById('passageCard');
  pc.textContent = currentItem.text;
  pc.classList.remove('animate');
  void pc.offsetHeight;
  pc.classList.add('animate');
 
  // Clear feedback
  setFeedback('', '');
 
  // Show book stage
  renderBookStage();
}
 
function renderBookStage() {
  quizStage = 'book';
  document.getElementById('stageBadge').textContent = 'Step 1 of 2';
  document.getElementById('stageText').textContent  = 'Which Harry Potter book is this from?';
 
  const area = document.getElementById('choicesArea');
  area.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'book-grid';
 
  HP_TITLES.forEach((title, i) => {
    const btn = document.createElement('button');
    btn.className = 'book-btn';
    btn.innerHTML = `<span class="book-num">Book ${i + 1}</span>${escHtml(title)}`;
    btn.addEventListener('click', () => handleBookAnswer(btn, i));
    grid.appendChild(btn);
  });
 
  area.appendChild(grid);
}
 
function handleBookAnswer(btn, chosenIndex) {
  if (answerLocked) return;
  answerLocked = true;
 
  const allBtns = document.querySelectorAll('.book-btn');
  allBtns.forEach(b => b.disabled = true);
 
  const correct = chosenIndex === currentItem.bookIndex;
 
  if (correct) {
    btn.classList.add('state-correct');
    setFeedback(`✓ Correct — now identify the chapter`, 'fb-info');
    // Transition to chapter stage after a short pause
    setTimeout(() => {
      setFeedback('', '');
      renderChapterStage();
    }, 900);
  } else {
    btn.classList.add('state-wrong');
    // Reveal correct book
    allBtns.forEach(b => {
      const bookNum = b.querySelector('.book-num').textContent; // "Book N"
      const idx = parseInt(bookNum.replace('Book ', '')) - 1;
      if (idx === currentItem.bookIndex) b.classList.add('state-reveal');
    });
    setFeedback(
      `✗ Wrong — it was from ${HP_FULL_TITLES[currentItem.bookIndex]}`,
      'fb-wrong'
    );
    setTimeout(() => triggerGameOver(btn), 1800);
  }
}
 
function renderChapterStage() {
  quizStage    = 'chapter';
  answerLocked = false;
 
  document.getElementById('stageBadge').textContent = 'Step 2 of 2';
  document.getElementById('stageText').textContent  = 'Now pick the exact chapter:';
 
  const chapters = currentItem.bookChapters; // all chapter titles for this book
 
  const area = document.getElementById('choicesArea');
  area.innerHTML = '';
 
  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'chapter-scroll-wrap';
  const grid = document.createElement('div');
  grid.className = 'chapter-grid';
 
  chapters.forEach((title, i) => {
    const btn = document.createElement('button');
    btn.className = 'chapter-btn';
    btn.style.animationDelay = Math.min(i * 18, 300) + 'ms';
    btn.textContent = title;
    btn.addEventListener('click', () => handleChapterAnswer(btn, title));
    grid.appendChild(btn);
  });
 
  scrollWrap.appendChild(grid);
  area.appendChild(scrollWrap);
}
 
function handleChapterAnswer(btn, chosenTitle) {
  if (answerLocked) return;
  answerLocked = true;
 
  const allBtns = document.querySelectorAll('.chapter-btn');
  allBtns.forEach(b => b.disabled = true);
 
  const correct = chosenTitle === currentItem.chapterTitle;
 
  if (correct) {
    btn.classList.add('state-correct');
    score++;
    updateScoreUI();
    setFeedback(`✦ Perfect — 1 point!`, 'fb-correct');
    setTimeout(nextQuestion, 1200);
  } else {
    btn.classList.add('state-wrong');
    // Reveal correct chapter
    allBtns.forEach(b => {
      if (b.textContent.trim() === currentItem.chapterTitle) {
        b.classList.add('state-reveal');
        // Scroll it into view
        b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    setFeedback(
      `✗ Not quite — it was "${currentItem.chapterTitle}". No point this round.`,
      'fb-partial'
    );
    setTimeout(nextQuestion, 2200);
  }
}
 
// ═══════════════════════════════════════════════════════
// GAME OVER
// ═══════════════════════════════════════════════════════
function triggerGameOver() {
  const isRecord = score > highScore;
  if (isRecord) {
    highScore = score;
    localStorage.setItem('hpOracle_hs', highScore);
  }
 
  document.getElementById('goScore').textContent      = score;
  document.getElementById('goRecord').style.display   = isRecord ? 'inline-flex' : 'none';
 
  // Context: show what they got wrong
  const ctx = document.getElementById('goContext');
  if (currentItem) {
    ctx.innerHTML =
      `The passage was from <strong>${HP_FULL_TITLES[currentItem.bookIndex]}</strong>,
       chapter <strong>${escHtml(currentItem.chapterTitle)}</strong>.`;
  } else {
    ctx.innerHTML = 'You conquered every passage in the library!';
    ctx.style.borderLeftColor = 'var(--gold)';
  }
 
  updateScoreUI();
  showScreen('gameoverScreen');
}
 
function restartGame() {
  // Rebuild pool from parsed books
  paragraphPool = [];
  const seenTexts = new Set();
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const chapterTitles = book.chapters.map(c => c.title);
    for (const ch of book.chapters) {
      for (const para of ch.paragraphs) {
        if (!seenTexts.has(para)) {
          seenTexts.add(para);
          paragraphPool.push({
            text:         para,
            chapterTitle: ch.title,
            bookIndex:    i,
            bookChapters: chapterTitles
          });
        }
      }
    }
  }
  shuffleArr(paragraphPool);
  score = 0;
  updateScoreUI();
  showScreen('quizScreen');
  nextQuestion();
}
 
// ═══════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════
function updateScoreUI() {
  document.getElementById('scoreDisplay').textContent = score;
  document.getElementById('hsDisplay').textContent    = highScore;
}
function setProgress(pct) {
  document.getElementById('progressFill').style.width = pct + '%';
}
function setLoadingBook(msg) {
  document.getElementById('loadingBook').textContent = msg;
}
function setFeedback(msg, cls) {
  const fb = document.getElementById('feedbackBar');
  fb.textContent = msg;
  fb.className   = 'feedback-bar' + (msg ? ` ${cls} show` : '');
}
 
// ═══════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════
function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
 
// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════
updateScoreUI();
initLoad();