(function() {
  'use strict';

  // ========== CONSTANTS ==========
  const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';
  const STORAGE_KEY = 'newspulse';

  let FEED_CONFIGS = {
    nyt: {
      name: 'NYT Homepage',
      urls: [
        'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
        'https://rss.nytimes.com/services/xml/rss/nyt/US.xml',
        'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
        'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml'
      ],
      subLabels: ['home', 'us', 'world', 'business'],
      enabled: true
    },
    wsj: {
      name: 'WSJ (Consolidated)',
      urls: [
        'https://news.google.com/rss/search?q=site:wsj.com&hl=en-US&gl=US&ceid=US:en',
        'https://news.google.com/rss/search?q=site:wsj.com+business&hl=en-US&gl=US&ceid=US:en',
        'https://news.google.com/rss/search?q=site:wsj.com+markets&hl=en-US&gl=US&ceid=US:en'
      ],
      subLabels: ['home', 'business', 'markets'],
      enabled: true
    },
    wapo: {
      name: 'Washington Post',
      urls: [
        'https://news.google.com/rss/search?q=site:washingtonpost.com&hl=en-US&gl=US&ceid=US:en',
        'https://news.google.com/rss/search?q=site:washingtonpost.com+politics&hl=en-US&gl=US&ceid=US:en',
        'https://news.google.com/rss/search?q=site:washingtonpost.com+business&hl=en-US&gl=US&ceid=US:en'
      ],
      subLabels: ['home', 'politics', 'business'],
      enabled: true
    }
  };

  let state = {
    discoverStories: [],
    discoverFilter: 'all',
    feedData: {},
    highlightGaps: false,
    gapResults: [],
    customFeeds: [],
    discoverVisible: 10,
    feedVisible: {},
    wsjFilter: 'all',
    wsjAllItems: [],
    gapVisible: 10,
    pasteTopic: 'top',
    currentOverlay: null,
    userAddedStories: [],
    discoverCachedAt: null,
  };

  Object.keys(FEED_CONFIGS).forEach(k => { state.feedVisible[k] = 10; });

  // ========== PERSISTENCE (in-memory only for sandboxed environments) ==========
  function loadSaved() {
    // No-op in sandboxed iframe — preferences are in-memory only
  }

  function savePreferences() {
    // No-op in sandboxed iframe — preferences are in-memory only
  }

  // ========== UTILITIES ==========
  function timeAgo(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      const now = new Date();
      const diff = Math.floor((now - d) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return Math.floor(diff / 86400) + 'd ago';
    } catch { return ''; }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function truncate(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  // ========== KEYWORD EXTRACTION ==========
  const STOP_WORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
    'from','is','it','its','this','that','was','are','were','be','been','being',
    'have','has','had','do','does','did','will','would','could','should','may',
    'might','can','shall','not','no','nor','so','up','out','if','about','who',
    'which','when','where','what','how','all','each','every','both','few','more',
    'most','other','some','such','than','too','very','just','also','now','new',
    'says','said','say','as','after','before','over','between','under','into',
    'during','since','he','she','they','them','their','his','her','we','you',
    'your','our','my','i','me','him','us','there','here','then','why','per','via'
  ]);

  function extractKeywords(title) {
    if (!title) return [];
    return title.toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  // ========== OP-ED / ROUNDUP DETECTION ==========
  const OPED_PATTERNS = ['opinion', 'editorial', 'commentary', 'analysis', 'letters to the editor', 'review'];

  function isOpEd(title) {
    const lower = (title || '').toLowerCase();
    if (/^(opinion|editorial|analysis|commentary|review)\s*[|:]/i.test(title)) return true;
    return OPED_PATTERNS.some(p => lower.startsWith(p + ' '));
  }

  function isRoundup(title) {
    const lower = (title || '').toLowerCase();
    return /\bmarket\s*talk\b/i.test(lower)
      || /\bbriefing\s*[|:]/i.test(lower)
      || /\bstocks?\s+to\s+watch\b/i.test(lower)
      || /\bwhat\s+to\s+watch\b/i.test(lower)
      || /\bwhat('s| is)\s+happening\b/i.test(lower)
      || /\bmorning\s+(brief|digest|report)\b/i.test(lower)
      || /\blive\s+updates?\b/i.test(lower)
      || /\bstock\s+market\s+(news|today)\b/i.test(lower)
      || /\bmonday\s+recap\b|\btuesday\s+recap\b|\bwednesday\s+recap\b|\bthursday\s+recap\b|\bfriday\s+recap\b/i.test(lower);
  }

  // Strip publisher suffixes and opinion prefixes from titles for cleaner matching
  function cleanTitle(title) {
    if (!title) return '';
    return title
      .replace(/\s*[–—-]\s*(The\s+)?(Washington Post|New York Times|Wall Street Journal|WSJ|NYT).*$/i, '')
      .replace(/^(Opinion|Editorial|Analysis|Commentary)\s*[|:]\s*/i, '')
      .trim();
  }

  // ========== PUBLISHER NORMALIZATION ==========
  function normalizePublisher(source) {
    const s = (source || '').toLowerCase();
    if (s.includes('nyt') || s.includes('new york times')) return 'NYT';
    if (s.includes('wsj') || s.includes('wall street')) return 'WSJ';
    if (s.includes('wash') || s.includes('wapo')) return 'WaPo';
    return source;
  }

  // ========== GAP ANALYSIS ==========

  // Extract distinctive terms (proper nouns, numbers, multi-word entities)
  // These are far better for cross-outlet story matching than generic keywords
  function extractEntities(title) {
    if (!title) return [];
    const entities = [];
    // Numbers with context (e.g., "$500", "150", "800")
    const nums = title.match(/\$?\d[\d,.]*\s*(?:billion|million|trillion|percent|%)?/gi) || [];
    nums.forEach(n => entities.push(n.toLowerCase().replace(/\s+/g, '')));
    // Proper nouns — capitalized words not at start of sentence, excluding common words
    const commonCaps = new Set(['the','a','an','in','on','at','to','for','of','with','by','as','is','are','and','but','or','after','live','updates','update','monday','tuesday','wednesday','thursday','friday']);
    const words = title.split(/\s+/);
    words.forEach((w, i) => {
      const clean = w.replace(/[^a-zA-Z'-]/g, '');
      if (clean.length > 2 && /^[A-Z]/.test(clean) && !commonCaps.has(clean.toLowerCase())) {
        entities.push(clean.toLowerCase());
      }
    });
    return entities;
  }

  function storiesMatch(kw1, ent1, kw2, ent2) {
    // Entity match: 2+ shared proper nouns/numbers = same story
    const entOverlap = ent1.filter(e => ent2.includes(e));
    if (entOverlap.length >= 2) return true;
    // Keyword match: need both entity and keyword overlap
    const kwOverlap = kw1.filter(kw => kw2.includes(kw));
    if (entOverlap.length >= 1 && kwOverlap.length >= 2) return true;
    // Strict keyword only: at least 3 shared keywords
    if (kwOverlap.length >= 3 && kwOverlap.length / Math.min(kw1.length, kw2.length) >= 0.3) return true;
    return false;
  }

  function computeGaps() {
    const perplexityProcessed = state.discoverStories.map(s => {
      const cleaned = cleanTitle(s.title);
      return {
        keywords: extractKeywords(cleaned),
        entities: extractEntities(cleaned),
        title: s.title
      };
    });

    const allCompetitor = [];
    for (const [feedId, items] of Object.entries(state.feedData)) {
      (items || []).forEach(item => {
        if (!isOpEd(item.title) && !isRoundup(item.title)) {
          const cleaned = cleanTitle(item.title);
          allCompetitor.push({
            ...item,
            cleanedTitle: cleaned,
            keywords: extractKeywords(cleaned),
            entities: extractEntities(cleaned),
            feedId,
            publisher: normalizePublisher(item.source || FEED_CONFIGS[feedId]?.name || feedId)
          });
        }
      });
    }

    // Find stories NOT covered by Discover
    const gaps = [];
    allCompetitor.forEach(story => {
      if (story.keywords.length === 0) return;

      let isCovered = false;
      for (const pStory of perplexityProcessed) {
        if (pStory.keywords.length === 0) continue;
        if (storiesMatch(story.keywords, story.entities, pStory.keywords, pStory.entities)) {
          isCovered = true;
          break;
        }
      }

      if (!isCovered) gaps.push(story);
    });

    // Group similar gap stories across outlets using entity matching
    const groups = [];
    gaps.forEach(g => {
      let merged = false;
      for (const group of groups) {
        if (storiesMatch(g.keywords, g.entities, group.keywords, group.entities)) {
          group.publishers.add(g.publisher);
          group.allStories.push(g);
          merged = true;
          break;
        }
      }

      if (!merged) {
        groups.push({
          title: g.cleanedTitle,
          link: g.link,
          description: g.description,
          keywords: g.keywords,
          entities: g.entities,
          publishers: new Set([g.publisher]),
          allStories: [g]
        });
      }
    });

    const ranked = groups.map(g => ({
      title: g.title,
      link: g.link,
      description: g.description,
      publishers: [...g.publishers],
      buzzScore: g.publishers.size,
      // Relevance: how many total gap stories relate to this topic
      relevanceScore: g.allStories.length
    }));

    ranked.sort((a, b) => {
      if (b.buzzScore !== a.buzzScore) return b.buzzScore - a.buzzScore;
      return b.relevanceScore - a.relevanceScore;
    });

    state.gapResults = ranked;
    return ranked;
  }

  function isStoryAGap(title) {
    if (!state.highlightGaps) return false;
    if (state.gapResults.length === 0) computeGaps();
    const topGaps = state.gapResults.slice(0, 10);
    const cleaned = cleanTitle(title);
    const titleKWs = extractKeywords(cleaned);
    const titleEnts = extractEntities(cleaned);
    if (titleKWs.length === 0) return false;

    for (const gap of topGaps) {
      const gapKWs = extractKeywords(gap.title);
      const gapEnts = extractEntities(gap.title);
      if (storiesMatch(titleKWs, titleEnts, gapKWs, gapEnts)) return true;
    }
    return false;
  }

  // ========== RENDERING ==========
  function renderStoryCard(story, opts = {}) {
    const gap = opts.checkGap && !isOpEd(story.title) && !isRoundup(story.title) && isStoryAGap(story.title);
    const topicClass = opts.topicClass || '';
    const gapClass = gap ? ' has-gap' : '';
    const href = story.link || story.url || '';

    // Suppress description if it just repeats the title (with optional publisher suffix)
    const descRaw = (story.description || '').replace(/<[^>]*>/g, '').trim();
    const descCleaned = cleanTitle(descRaw);
    const titleCleaned = cleanTitle(story.title);
    const showDesc = descCleaned.length > 20
      && descCleaned.toLowerCase() !== titleCleaned.toLowerCase()
      && !titleCleaned.toLowerCase().startsWith(descCleaned.toLowerCase().slice(0, 30));

    return `
      <div class="story-card${topicClass ? ' ' + topicClass : ''}${gapClass}">
        <div class="gap-dot"></div>
        <div class="card-title">
          <a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(cleanTitle(story.title))}</a>
        </div>
        <div class="card-meta">
          <span class="meta-src">${escapeHtml(story.source || '')}</span>
          ${story.topic ? `<span class="topic-tag tag-${story.topic}">${story.topic === 'tech' ? 'Tech & Science' : story.topic === 'finance' ? 'Finance' : 'Top'}</span>` : ''}
          ${story.sourceCount ? `<span>${escapeHtml(story.sourceCount)}</span>` : ''}
          <span>${timeAgo(story.pubDate)}</span>
        </div>
        ${showDesc ? `<div class="card-desc">${escapeHtml(truncate(descCleaned, 200))}</div>` : ''}
      </div>
    `;
  }

  function renderLoadMore(currentCount, totalCount, onClickFn) {
    const remaining = totalCount - currentCount;
    if (remaining <= 0) return '';
    return `<button class="load-more-btn" onclick="${onClickFn}">Show 10 more (${remaining} remaining)</button>`;
  }

  function renderDiscoverColumn() {
    const body = document.getElementById('discover-body');
    let stories = state.discoverStories;

    if (state.discoverFilter !== 'all') {
      stories = stories.filter(s => s.topic === state.discoverFilter);
    } else {
      // "All" shows all 3 topics interleaved by recency with topic round-robin for ties
      const topicOrder = { top: 0, tech: 1, finance: 2 };
      stories = [...stories].sort((a, b) => {
        const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        if (db !== da) return db - da;  // most recent first
        // For same timestamp, interleave topics
        return (topicOrder[a.topic] || 0) - (topicOrder[b.topic] || 0);
      });
    }

    document.getElementById('discover-count').textContent = stories.length;

    // Show last-refreshed timestamp
    const tsEl = document.getElementById('discover-timestamp');
    if (tsEl && state.discoverCachedAt) {
      const ago = timeAgo(new Date(state.discoverCachedAt));
      tsEl.textContent = 'Updated ' + ago;
      tsEl.title = new Date(state.discoverCachedAt).toLocaleString();
    }

    if (stories.length === 0) {
      body.innerHTML = `<div class="column-status">No Discover stories loaded.<br><br><span style="font-size:10px;color:var(--text-muted)">Use <span class="guide-kbd">P</span> to paste stories manually.</span></div>`;
      return;
    }

    const visible = stories.slice(0, state.discoverVisible);
    let html = visible.map(s => {
      const topicClass = s.topic === 'top' ? 'topic-top' : s.topic === 'tech' ? 'topic-tech' : s.topic === 'finance' ? 'topic-finance' : '';
      return renderStoryCard(s, { topicClass });
    }).join('');

    html += renderLoadMore(visible.length, stories.length, 'showMoreDiscover()');
    body.innerHTML = html;
  }

  function renderFeedColumn(feedId) {
    const body = document.getElementById(feedId + '-body');
    const items = state.feedData[feedId] || [];
    const countEl = document.getElementById(feedId + '-count');
    if (countEl) countEl.textContent = items.length;

    if (items.length === 0) {
      body.innerHTML = `<div class="column-status">No stories loaded.</div>`;
      return;
    }

    const count = state.feedVisible[feedId] || 10;
    const visible = items.slice(0, count);

    let html = visible.map(s => renderStoryCard(s, { checkGap: true })).join('');
    html += renderLoadMore(visible.length, items.length, `showMoreFeed('${feedId}')`);
    body.innerHTML = html;
  }

  function renderAllFeeds() {
    Object.keys(FEED_CONFIGS).forEach(id => {
      if (FEED_CONFIGS[id].enabled) renderFeedColumn(id);
    });
    state.customFeeds.forEach(cf => {
      if (cf.enabled) renderFeedColumn(cf.id);
    });
  }

  function renderGapAnalysis() {
    const body = document.getElementById('gap-analysis-body');
    const gaps = computeGaps();

    if (gaps.length === 0) {
      body.innerHTML = `<div class="column-status" style="padding:40px;color:var(--text-secondary);">No coverage gaps detected. Perplexity Discover appears to have good coverage of current stories.</div>`;
      return;
    }

    const visible = gaps.slice(0, state.gapVisible);
    let html = visible.map((gap, i) => {
      const cleaned = cleanTitle(gap.title);
      const desc = gap.description || '';
      const descClean = cleanTitle(desc.replace(/<[^>]*>/g, ''));
      const showDesc = descClean.length > 30 && descClean.toLowerCase() !== cleaned.toLowerCase()
        && !cleaned.toLowerCase().startsWith(descClean.toLowerCase().slice(0, 40));
      const isMulti = gap.buzzScore > 1;

      // Build colored outlet tags
      const outletTags = gap.publishers.map(p => {
        const cls = p === 'NYT' ? 'nyt' : p === 'WSJ' ? 'wsj' : p === 'WaPo' ? 'wapo' : 'other';
        return `<span class="gap-outlet-tag ${cls}">${escapeHtml(p)}</span>`;
      }).join('');

      return `
        <div class="gap-item${isMulti ? ' multi-outlet' : ''}">
          <div class="gap-rank">${i + 1}.</div>
          <div class="gap-content">
            <div class="gap-title"><a href="${escapeHtml(gap.link)}" target="_blank" rel="noopener">${escapeHtml(cleaned)}</a></div>
            <div class="gap-sources">${outletTags}</div>
            ${showDesc ? `<div class="gap-desc">${escapeHtml(truncate(descClean, 180))}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    const remaining = gaps.length - visible.length;
    if (remaining > 0) {
      html += `<button class="load-more-btn" onclick="showMoreGaps()" style="margin-top:12px">Show 10 more (${remaining} remaining)</button>`;
    }

    body.innerHTML = html;
  }

  function renderSourceManager() {
    const body = document.getElementById('sources-body');
    let html = '';

    Object.entries(FEED_CONFIGS).forEach(([id, cfg]) => {
      html += `
        <div class="source-row">
          <div class="source-info">
            <div class="source-name">${escapeHtml(cfg.name)}</div>
            <div class="source-url">${escapeHtml(cfg.urls[0])}${cfg.urls.length > 1 ? ` (+${cfg.urls.length - 1} more)` : ''}</div>
          </div>
          <button class="source-toggle${cfg.enabled ? ' on' : ''}" onclick="toggleSource('${id}')"></button>
        </div>
      `;
    });

    state.customFeeds.forEach(cf => {
      html += `
        <div class="source-row">
          <div class="source-info">
            <div class="source-name">${escapeHtml(cf.name)} <span style="font-family:var(--font-mono);font-size:9px;color:var(--text-muted)">[CUSTOM]</span></div>
            <div class="source-url">${escapeHtml(cf.url)}</div>
          </div>
          <button class="source-toggle${cf.enabled ? ' on' : ''}" onclick="toggleCustomSource('${cf.id}')"></button>
        </div>
      `;
    });

    html += `
      <div class="add-custom-feed">
        <input type="text" id="custom-feed-url" placeholder="https://example.com/rss.xml">
        <button onclick="addCustomFeed()">ADD FEED</button>
      </div>
    `;

    body.innerHTML = html;
  }

  // ========== DATA FETCHING ==========
  async function fetchDiscover() {
    try {
      // Try inline data first (for static deployments that can't fetch due to CORS)
      let data = window.__PERPLEXITY_CACHE__ || null;
      
      if (!data) {
        // Fallback to fetch (works when served from same origin, e.g. GitHub Pages)
        // Cache-bust to avoid stale CDN/browser cache
        const res = await fetch('perplexity_cache.json?t=' + Date.now());
        if (res.ok) {
          data = await res.json();
        }
      }

      if (data) {
        let stories = [];
        if (data.stories && data.stories.length > 0) {
          stories = data.stories.map(s => ({
            ...s,
            link: s.url || s.link || '',
            topic: s.topic || 'top'
          }));
        } else if (data.topics) {
          ['top', 'tech', 'finance'].forEach(t => {
            (data.topics[t] || []).forEach(s => {
              stories.push({ ...s, link: s.url || s.link || '', topic: t });
            });
          });
        }
        // Deduplicate by URL (API can return same story across topics)
        const seen = new Set();
        stories = stories.filter(s => {
          const key = s.link || s.url || s.title;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        state.discoverStories = stories;
        state.discoverCachedAt = data.cached_at || null;
      }
    } catch (e) {
      console.warn('Discover cache unavailable:', e.message);
    }

    if (state.userAddedStories.length > 0) {
      state.discoverStories = [...state.userAddedStories, ...state.discoverStories];
    }

    state.discoverVisible = 10;
    renderDiscoverColumn();
  }

  async function fetchFeed(feedId, cfg) {
    const allItems = [];

    for (let i = 0; i < cfg.urls.length; i++) {
      const url = cfg.urls[i];
      const subLabel = cfg.subLabels ? cfg.subLabels[i] : null;
      try {
        const res = await fetch(RSS2JSON_API + encodeURIComponent(url));
        if (!res.ok) continue;
        const data = await res.json();

        (data.items || []).forEach(item => {
          // Clean title: strip " - WSJ" or " - The Wall Street Journal" suffixes from Google News proxy
          let cleanedTitle = (item.title || '')
            .replace(/\s*-\s*(WSJ|The Wall Street Journal)\s*$/i, '')
            .trim();
          const entry = {
            title: cleanedTitle,
            link: item.link || '',
            description: (item.description || '').replace(/<[^>]*>/g, '').slice(0, 300),
            pubDate: item.pubDate || '',
            author: item.author || '',
            source: cfg.name
          };
          if (subLabel) entry.subFeed = subLabel;
          allItems.push(entry);
        });
      } catch (e) {
        console.warn('Feed fetch failed:', url, e.message);
      }
    }

    const seen = new Set();
    const deduped = allItems.filter(item => {
      if (isOpEd(item.title) || isRoundup(item.title)) return false;
      const key = (item.title || '').toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    state.feedData[feedId] = deduped;
    state.feedVisible[feedId] = 10;
    if (feedId === 'wsj') state.wsjAllItems = deduped;
  }

  async function fetchAllFeeds() {
    const promises = Object.entries(FEED_CONFIGS)
      .filter(([, cfg]) => cfg.enabled)
      .map(([id, cfg]) => fetchFeed(id, cfg));
    await Promise.all(promises);
    renderAllFeeds();
  }

  async function fetchCustomFeed(cf) {
    try {
      const res = await fetch(RSS2JSON_API + encodeURIComponent(cf.url));
      if (!res.ok) throw new Error('Fetch error');
      const data = await res.json();

      state.feedData[cf.id] = (data.items || []).map(item => ({
        title: item.title || '',
        link: item.link || '',
        description: (item.description || '').replace(/<[^>]*>/g, '').slice(0, 300),
        pubDate: item.pubDate || '',
        author: item.author || '',
        source: cf.name
      }));
      state.feedVisible[cf.id] = 10;
    } catch (e) {
      console.warn('Custom feed error:', e.message);
      state.feedData[cf.id] = [];
    }
  }

  // ========== ACTIONS ==========
  window.refreshAll = async function() {
    Object.keys(FEED_CONFIGS).forEach(id => {
      const body = document.getElementById(id + '-body');
      if (body) body.innerHTML = '<div class="column-status"><div class="spinner"></div>Refreshing…</div>';
    });
    document.getElementById('discover-body').innerHTML = '<div class="column-status"><div class="spinner"></div>Refreshing…</div>';

    state.discoverVisible = 10;
    Object.keys(state.feedVisible).forEach(k => { state.feedVisible[k] = 10; });
    state.gapVisible = 10;
    state.gapResults = [];  // Force gap recompute after refresh

    fetchDiscover();
    await fetchAllFeeds();

    for (const cf of state.customFeeds) {
      if (cf.enabled) {
        await fetchCustomFeed(cf);
        renderFeedColumn(cf.id);
      }
    }

    if (state.feedData['wsj']) state.wsjAllItems = state.feedData['wsj'];
  };

  window.toggleHighlightGaps = function() {
    state.highlightGaps = !state.highlightGaps;
    const btn = document.getElementById('btn-highlight');
    btn.classList.toggle('active', state.highlightGaps);
    if (state.highlightGaps) {
      state.gapResults = [];  // Force recompute
      computeGaps();
    }
    renderAllFeeds();
  };

  window.setWsjFilter = function(filter, el) {
    state.wsjFilter = filter;
    state.feedVisible['wsj'] = 10;
    document.querySelectorAll('#wsj-filters .filter-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');

    if (filter === 'all') {
      state.feedData['wsj'] = state.wsjAllItems;
    } else {
      state.feedData['wsj'] = state.wsjAllItems.filter(s => s.subFeed === filter);
    }
    renderFeedColumn('wsj');
  };

  window.setDiscoverFilter = function(filter, el) {
    state.discoverFilter = filter;
    state.discoverVisible = 10;
    document.querySelectorAll('#discover-filters .filter-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    renderDiscoverColumn();
  };

  window.showMoreDiscover = function() {
    state.discoverVisible += 10;
    renderDiscoverColumn();
  };

  window.showMoreFeed = function(feedId) {
    state.feedVisible[feedId] = (state.feedVisible[feedId] || 10) + 10;
    renderFeedColumn(feedId);
  };

  window.showMoreGaps = function() {
    state.gapVisible += 10;
    renderGapAnalysis();
  };

  window.toggleSource = function(id) {
    FEED_CONFIGS[id].enabled = !FEED_CONFIGS[id].enabled;
    savePreferences();
    renderSourceManager();

    const col = document.getElementById('col-' + id);
    if (col) col.style.display = FEED_CONFIGS[id].enabled ? '' : 'none';
    if (FEED_CONFIGS[id].enabled) renderFeedColumn(id);
  };

  window.toggleCustomSource = function(id) {
    const cf = state.customFeeds.find(f => f.id === id);
    if (cf) {
      cf.enabled = !cf.enabled;
      savePreferences();
      renderSourceManager();
      const col = document.getElementById('col-' + id);
      if (col) col.style.display = cf.enabled ? '' : 'none';
    }
  };

  window.addCustomFeed = function() {
    const input = document.getElementById('custom-feed-url');
    const url = (input.value || '').trim();
    if (!url) return;

    const id = 'custom_' + state.customFeeds.length;
    let name;
    try { name = 'Custom: ' + new URL(url).hostname; } catch { name = 'Custom Feed'; }
    const cf = { id, name, url, enabled: true };
    state.customFeeds.push(cf);
    savePreferences();

    createCustomColumn(cf);
    fetchCustomFeed(cf).then(() => renderFeedColumn(cf.id));
    input.value = '';
    renderSourceManager();
  };

  function createCustomColumn(cf) {
    const main = document.querySelector('.main-container');
    const col = document.createElement('div');
    col.className = 'column';
    col.id = 'col-' + cf.id;
    col.innerHTML = `
      <div class="column-header">
        <div class="column-title">
          <span class="source-dot" style="background:var(--accent-blue)"></span>
          ${escapeHtml(cf.name)}
          <span class="count-badge" id="${cf.id}-count">0</span>
        </div>
      </div>
      <div class="column-body" id="${cf.id}-body">
        <div class="column-status"><div class="spinner"></div>Loading…</div>
      </div>
    `;
    main.appendChild(col);
  }

  // ========== QUICK PASTE ==========
  window.setPasteTopic = function(topic) {
    state.pasteTopic = topic;
    ['top', 'tech', 'finance'].forEach(t => {
      document.getElementById('paste-topic-' + t).classList.toggle('active', t === topic);
    });
  };

  window.submitPaste = function() {
    const input = document.getElementById('paste-input');
    const lines = (input.value || '').split('\n').map(l => l.trim()).filter(Boolean);

    const newStories = lines.map(title => ({
      title,
      link: '',
      description: '',
      pubDate: new Date().toISOString(),
      source: 'Perplexity Discover',
      topic: state.pasteTopic
    }));

    state.userAddedStories = [...newStories, ...state.userAddedStories];
    state.discoverStories = [...newStories, ...state.discoverStories];
    savePreferences();

    input.value = '';
    closeOverlay('quick-paste');
    state.discoverVisible = 10;
    state.gapResults = [];  // Force gap recompute with new stories
    renderDiscoverColumn();
    if (state.highlightGaps) renderAllFeeds();
  };

  // ========== OVERLAYS ==========
  window.openOverlay = function(id) {
    if (state.currentOverlay === id) {
      closeOverlay(id);
      return;
    }

    if (state.currentOverlay) {
      document.getElementById('overlay-' + state.currentOverlay).classList.remove('visible');
    }

    if (id === 'gap-analysis') {
      state.gapVisible = 10;
      renderGapAnalysis();
    } else if (id === 'add-sources') {
      renderSourceManager();
    } else if (id === 'social-pulse') {
      setTimeout(() => {
        if (window.twttr && window.twttr.widgets) window.twttr.widgets.load();
      }, 100);
    }

    document.getElementById('overlay-' + id).classList.add('visible');
    state.currentOverlay = id;
  };

  window.closeOverlay = function(id) {
    document.getElementById('overlay-' + id).classList.remove('visible');
    if (state.currentOverlay === id) state.currentOverlay = null;
  };

  window.closeOverlayBackdrop = function(e) {
    if (e.target.classList.contains('overlay-backdrop') && state.currentOverlay) {
      closeOverlay(state.currentOverlay);
    }
  };

  // ========== KEYBOARD SHORTCUTS ==========
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape' && state.currentOverlay) {
        closeOverlay(state.currentOverlay);
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'r': refreshAll(); break;
      case 'h': toggleHighlightGaps(); break;
      case 'g': openOverlay('gap-analysis'); break;
      case 's': openOverlay('social-pulse'); break;
      case 'a': openOverlay('add-sources'); break;
      case 'i': openOverlay('guide'); break;
      case 'p': openOverlay('quick-paste'); break;
      case 'escape':
        if (state.currentOverlay) closeOverlay(state.currentOverlay);
        break;
    }
  });

  // ========== INIT ==========
  async function init() {
    loadSaved();

    // Recreate any custom feed columns from saved preferences
    state.customFeeds.forEach(cf => {
      if (cf.enabled) createCustomColumn(cf);
    });

    // Hide disabled built-in columns
    Object.entries(FEED_CONFIGS).forEach(([id, cfg]) => {
      if (!cfg.enabled) {
        const col = document.getElementById('col-' + id);
        if (col) col.style.display = 'none';
      }
    });

    // Fetch everything
    fetchDiscover();
    await fetchAllFeeds();

    if (state.feedData['wsj']) state.wsjAllItems = state.feedData['wsj'];

    for (const cf of state.customFeeds) {
      if (cf.enabled) {
        await fetchCustomFeed(cf);
        renderFeedColumn(cf.id);
      }
    }
  }

  init();
})();
