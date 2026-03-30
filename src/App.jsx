import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import {
  ExternalLink, BookOpen, Users, FileText, AlertCircle,
  Loader2, Moon, Sun, Calendar, ChevronDown, Search,
  Building2, X, Filter, BarChart2, Tag, Newspaper, Sparkles
} from 'lucide-react';

// ── Brand kleur ────────────────────────────────────────────────────────────
const BRAND     = '#C4226B';
const BRAND_DARK = '#a81d5c';

// ── Anthropic client (optioneel, alleen als key beschikbaar) ───────────────
const anthropic = import.meta.env.VITE_ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY, dangerouslyAllowBrowser: true })
  : null;

// ── Samenvatting cache (localStorage) ──────────────────────────────────────
const SUMMARY_CACHE_KEY = 'antonius-summaries';
const readSummaryCache = () => {
  try { return JSON.parse(localStorage.getItem(SUMMARY_CACHE_KEY) || '{}'); }
  catch { return {}; }
};
const writeSummaryCache = (cache) => {
  try { localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(cache)); }
  catch { /* vol — skip */ }
};

// ── EuropePMC zoekquery ────────────────────────────────────────────────────
const BASE_QUERY =
  `(AFF:("antonius") AND AFF:("nieuwegein")) ` +
  `OR AFF:("antonius ziekenhuis utrecht") ` +
  `OR AFF:("antonius hospital utrecht")`;

// ── Afdeling normalisatie (volgorde is belangrijk: specifieker eerst!) ─────
const DEPT_RULES = [
  // Chirurgische subspecialismen (vóór generiek "surg")
  [/cardiothorac/i,                    'Cardiothoracale Chirurgie'],
  [/vascular surg/i,                   'Vaatchirurgie'],
  [/trauma surg/i,                     'Traumachirurgie'],
  [/orthop/i,                          'Orthopedie'],
  [/plastic|reconstruct/i,             'Plastische Chirurgie'],
  // Generiek chirurgie
  [/surg/i,                            'Chirurgie'],
  // Hart
  [/cardiol/i,                         'Cardiologie'],
  // Longen (ILD = onderdeel van longziekten)
  [/pulmonol|respirat|longziek|ild|interstitial lung/i, 'Longziekten'],
  // Urologie
  [/urol/i,                            'Urologie'],
  // Maag-darm
  [/gastroenterol|leverziek/i,         'Maag-Darm-Leverziekten'],
  // Beeldvorming
  [/nuclear med/i,                     'Nucleaire Geneeskunde'],
  [/interventional radiol/i,           'Interventieradiologie'],
  [/radiol/i,                          'Radiologie'],
  // Oncologie & radiotherapie
  [/radiation oncol/i,                 'Oncologie'],
  [/medical oncol|oncol/i,             'Oncologie'],
  // Interne geneeskunde (incl. hematologie, reumatologie)
  [/rheumatol/i,                       'Reumatologie'],
  [/hematol/i,                         'Interne Geneeskunde'],
  [/internal med/i,                    'Interne Geneeskunde'],
  // Farmacie (alles → Klinische Farmacie)
  [/pharm/i,                           'Klinische Farmacie'],
  // Laboratorium
  [/clinical chem/i,                   'Klinische Chemie'],
  [/pathol/i,                          'Pathologie'],
  // Neuro
  [/neuro.oncol/i,                     'Neurologie'],
  [/neurophysiol/i,                    'Neurologie'],
  [/neurol/i,                          'Neurologie'],
  [/neurosurg/i,                       'Neurochirurgie'],
  // Overige kliniek
  [/paediatric|pediatric/i,            'Kindergeneeskunde'],
  [/psychiatr|medical psychol/i,       'Psychiatrie & Medische Psychologie'],
  [/anaesthesiol|anesthesiol|anesthesia|intensive care/i, 'Anesthesiologie & Intensieve Zorg'],
  [/otorhinol|ent\b/i,                 'KNO'],
  // Ondersteunend
  [/medical physics/i,                 'Medische Fysica'],
  [/microbiol/i,                       'Medische Microbiologie'],
  [/dietetic/i,                        'Diëtetiek'],
  [/value|kwaliteit/i,                 'Kwaliteit & Waarde'],
  [/research|statist|development/i,    'Onderzoek & Ontwikkeling'],
];

function extractDepartments(article) {
  const authors = article.authorList?.author || [];
  const found = new Set();
  for (const author of authors) {
    const affs = author.authorAffiliationDetailsList?.authorAffiliation || [];
    for (const { affiliation: aff = '' } of affs) {
      if (!aff.toLowerCase().includes('antonius')) continue;
      const m = aff.match(/^(Department of [^,]+|Afdeling [^,]+)/i);
      const s = m ? m[1] : aff;
      let matched = false;
      for (const [re, label] of DEPT_RULES) {
        if (re.test(s)) { found.add(label); matched = true; break; }
      }
      if (!matched) found.add('Overig');
    }
  }
  return found.size > 0 ? [...found] : ['Overig'];
}

function extractAntoniusAuthors(article) {
  const result = [];
  for (const author of article.authorList?.author || []) {
    const affs = author.authorAffiliationDetailsList?.authorAffiliation || [];
    if (affs.some(a => a.affiliation?.toLowerCase().includes('antonius')) && author.fullName) {
      result.push(author.fullName);
    }
  }
  return result;
}

// ── Datum parsen (jaar-only → 31 dec, zodat sortering correct werkt) ───────
function parseDate(d) {
  if (!d) return new Date(0);
  if (/^\d{4}$/.test(d)) return new Date(`${d}-12-31`);
  return new Date(d);
}

// ── API helper ────────────────────────────────────────────────────────────
async function epmc(query, pageSize = 12, cursor = '*') {
  // EuropePMC vereist sort_date:y IN de query, niet als URL-parameter
  const q = query.includes('sort_date') ? query : `${query} sort_date:y`;
  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search` +
    `?query=${encodeURIComponent(q)}` +
    `&format=json&resultType=core` +
    `&pageSize=${pageSize}` +
    `&cursorMark=${encodeURIComponent(cursor)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Europe PMC API fout');
  return res.json();
}

// ── SVG Staafdiagram ──────────────────────────────────────────────────────
function BarChart({ data, color }) {
  if (!data?.length) return null;
  const maxVal = Math.max(...data.map(d => d.value), 1);
  const n = data.length;
  const W = 400, H = 90, PAD = 20;
  const barW = Math.max(8, Math.floor((W - PAD) / n) - 3);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + PAD}`} className="overflow-visible">
      {data.map((d, i) => {
        const h   = Math.max(2, Math.round((d.value / maxVal) * H));
        const x   = PAD / 2 + i * ((W - PAD) / n);
        const y   = H - h;
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={barW} height={h} rx={2} fill={color} opacity={0.85}>
              <title>{d.label}: {d.value}</title>
            </rect>
            <text
              x={x + barW / 2} y={H + 14}
              textAnchor="middle" fontSize={9}
              className="fill-slate-400 dark:fill-slate-500"
            >
              {String(d.label).slice(-2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Afdeling Profiel Modal ────────────────────────────────────────────────
function DeptProfileModal({ dept, onClose }) {
  const [stats, setStats]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true); setError(null);
      try {
        // Haal per jaar de publicaties op (2015 t/m huidig jaar) in parallel
        const thisYear = new Date().getFullYear();
        const years    = Array.from({ length: thisYear - 2014 }, (_, i) => 2015 + i);

        const perYear = await Promise.all(
          years.map(async year => {
            try {
              const q = `(${BASE_QUERY}) AND PUB_YEAR:${year}`;
              const data = await epmc(q, 100);
              const articles = (data.resultList?.result || [])
                .filter(a => extractDepartments(a).includes(dept));
              return { year, articles };
            } catch { return { year, articles: [] }; }
          })
        );

        if (cancelled) return;

        // Aggregeer alle artikelen
        const allArticles = perYear.flatMap(p => p.articles);

        const journalCounts = {};
        const authorCounts  = {};
        const topicCounts   = {};

        for (const a of allArticles) {
          const journal = a.journalInfo?.journal?.title || a.journalTitle || '';
          if (journal) journalCounts[journal] = (journalCounts[journal] || 0) + 1;

          for (const name of extractAntoniusAuthors(a))
            authorCounts[name] = (authorCounts[name] || 0) + 1;

          for (const kw of a.keywordList?.keyword || []) {
            if (kw && kw.length > 2 && kw.length < 60) {
              const k = kw.charAt(0).toUpperCase() + kw.slice(1).toLowerCase();
              topicCounts[k] = (topicCounts[k] || 0) + 1;
            }
          }
          for (const m of a.meshHeadingList?.meshHeading || []) {
            const t = m.descriptorName;
            if (t && t.length > 2 && t.length < 60)
              topicCounts[t] = (topicCounts[t] || 0) + 1;
          }
        }

        // Jaardiagram (alleen jaren met ≥1 publicatie + aangrenzende jaren)
        const activeYears = perYear.filter(p => p.articles.length > 0);
        const firstYear   = activeYears[0]?.year ?? thisYear;
        const yearChartData = perYear
          .filter(p => p.year >= firstYear)
          .map(p => ({ label: String(p.year), value: p.articles.length }));

        // Recente publicaties (meest recent)
        const recentPubs = [...allArticles]
          .sort((a, b) => parseDate(b.firstPublicationDate || b.pubYear) - parseDate(a.firstPublicationDate || a.pubYear))
          .slice(0, 4)
          .map(a => ({
            id:    a.pmid || a.id,
            title: a.title || 'Geen titel',
            date:  a.firstPublicationDate || a.pubYear || '',
            link:  `https://europepmc.org/article/${a.source || 'MED'}/${a.pmid || a.id}`,
          }));

        const minYear = firstYear;
        const maxYear = activeYears[activeYears.length - 1]?.year ?? thisYear;

        setStats({
          count:         allArticles.length,
          cappedPerYear: perYear.some(p => p.articles.length >= 100),
          minYear, maxYear,
          yearChartData,
          topJournals:   Object.entries(journalCounts).sort((a, b) => b[1] - a[1]).slice(0, 5),
          topAuthors:    Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 6),
          topTopics:     Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
          recentPubs,
        });
      } catch (e) {
        if (!cancelled) setError('Kon statistieken niet ophalen.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [dept]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl bg-white dark:bg-slate-800 rounded-2xl shadow-2xl my-8 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between" style={{ backgroundColor: BRAND }}>
          <div>
            <h2 className="text-xl font-bold text-white">{dept}</h2>
            <p className="text-white/75 text-sm mt-0.5">St. Antonius Ziekenhuis</p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {loading && (
            <div className="flex flex-col items-center py-16">
              <Loader2 size={36} className="animate-spin mb-3" style={{ color: BRAND }} />
              <p className="text-slate-500 dark:text-slate-400 text-sm">
                Statistieken ophalen per jaar…
              </p>
            </div>
          )}
          {error && (
            <div className="flex items-center gap-3 text-red-600 dark:text-red-400 py-8">
              <AlertCircle size={20} /><span>{error}</span>
            </div>
          )}
          {!loading && !error && stats && (
            <div className="space-y-6">

              {/* Stat boxes */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 text-center">
                  <div className="text-3xl font-bold" style={{ color: BRAND }}>
                    {stats.cappedPerYear ? `${stats.count}+` : stats.count}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">Publicaties gevonden</div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 text-center">
                  <div className="text-3xl font-bold" style={{ color: BRAND }}>
                    {stats.minYear !== stats.maxYear
                      ? `${stats.minYear}–${stats.maxYear}`
                      : stats.minYear}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">Actieve jaren</div>
                </div>
              </div>

              {/* Staafdiagram */}
              {stats.yearChartData.length > 0 && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <BarChart2 size={16} style={{ color: BRAND }} />
                    Publicaties per jaar
                  </h3>
                  <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4">
                    <BarChart data={stats.yearChartData} color={BRAND} />
                  </div>
                  {stats.cappedPerYear && (
                    <p className="text-xs text-slate-400 mt-1">
                      * Aantallen zijn per jaar afgetopt op 100 (steekproef)
                    </p>
                  )}
                </div>
              )}

              {/* Top Journals & Onderwerpen */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {stats.topJournals.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                      <Newspaper size={16} style={{ color: BRAND }} />
                      Top Journals
                    </h3>
                    <ul className="space-y-2">
                      {stats.topJournals.map(([journal, count]) => (
                        <li key={journal} className="flex items-center justify-between gap-2">
                          <span className="text-sm text-slate-600 dark:text-slate-300 line-clamp-1 flex-1" title={journal}>
                            {journal}
                          </span>
                          <span className="shrink-0 w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center text-white"
                            style={{ backgroundColor: BRAND }}>
                            {count}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {stats.topTopics.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                      <Tag size={16} style={{ color: BRAND }} />
                      Top Onderwerpen
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {stats.topTopics.map(([topic, count]) => (
                        <span key={topic}
                          className="text-xs px-2.5 py-1 rounded-full border font-medium"
                          style={{ borderColor: BRAND, color: BRAND }}>
                          {topic} <span className="opacity-60">({count})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Meest voorkomende auteurs */}
              {stats.topAuthors.length > 0 && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <Users size={16} style={{ color: BRAND }} />
                    Meest voorkomende auteurs
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {stats.topAuthors.map(([author, count]) => (
                      <span key={author}
                        className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-full">
                        {author}
                        <span className="text-xs font-bold px-1.5 py-0.5 rounded-full text-white"
                          style={{ backgroundColor: BRAND }}>{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Recente publicaties */}
              {stats.recentPubs.length > 0 && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <BookOpen size={16} style={{ color: BRAND }} />
                    Recente publicaties
                  </h3>
                  <ul className="space-y-1">
                    {stats.recentPubs.map(pub => (
                      <li key={pub.id}>
                        <a href={pub.link} target="_blank" rel="noopener noreferrer"
                          className="flex items-start gap-2 group hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg p-2 -mx-2 transition-colors">
                          <ExternalLink size={14} className="shrink-0 mt-0.5 opacity-40 group-hover:opacity-100 transition-opacity"
                            style={{ color: BRAND }} />
                          <div>
                            <p className="text-sm text-slate-700 dark:text-slate-200 line-clamp-2 group-hover:underline leading-snug">
                              {pub.title}
                            </p>
                            {pub.date && (
                              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{pub.date}</p>
                            )}
                          </div>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Publiekssamenvatting Modal ─────────────────────────────────────────────
function SummaryModal({ pub, onClose }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function generate() {
      setLoading(true);
      setError(null);

      // Check cache
      const cache = readSummaryCache();
      if (cache[pub.id]) {
        setSummary(cache[pub.id]);
        setLoading(false);
        return;
      }

      if (!anthropic) {
        setError('Geen API-key geconfigureerd. Stel VITE_ANTHROPIC_API_KEY in.');
        setLoading(false);
        return;
      }

      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `Je bent een wetenschapscommunicator. Schrijf een heldere publieksamenvatting in het Nederlands (max 150 woorden) van het volgende wetenschappelijke artikel. Gebruik begrijpelijke taal, vermijd jargon, en leg uit waarom dit onderzoek relevant is voor patiënten of de maatschappij.

Titel: ${pub.title}
Tijdschrift: ${pub.journal}
Afdeling: ${pub.departments?.filter(d => d !== 'Overig').join(', ') || 'Onbekend'}
Abstract: ${pub.abstractFull || pub.abstract || 'Niet beschikbaar'}

Schrijf alleen de samenvatting, geen inleiding of titel.`
          }]
        });

        const text = response.content.find(b => b.type === 'text')?.text || '';

        if (!cancelled) {
          setSummary(text);
          // Cache opslaan
          const c = readSummaryCache();
          c[pub.id] = text;
          writeSummaryCache(c);
        }
      } catch (e) {
        console.error('Samenvatting fout:', e);
        if (!cancelled) setError('Kon de samenvatting niet genereren. Probeer het later opnieuw.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    generate();
    return () => { cancelled = true; };
  }, [pub]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg bg-white dark:bg-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between" style={{ backgroundColor: BRAND }}>
          <div className="flex items-center gap-2 text-white">
            <Sparkles size={18} />
            <h3 className="font-semibold text-sm">Publiekssamenvatting</h3>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center">
            <X size={16} />
          </button>
        </div>
        {/* Titel */}
        <div className="px-5 pt-4 pb-2">
          <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 leading-snug">
            {pub.title}
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{pub.journal} · {pub.date}</p>
        </div>
        {/* Body */}
        <div className="px-5 pb-5 pt-2">
          {loading && (
            <div className="flex items-center gap-3 py-8">
              <Loader2 size={20} className="animate-spin" style={{ color: BRAND }} />
              <span className="text-sm text-slate-500 dark:text-slate-400">Samenvatting genereren…</span>
            </div>
          )}
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400 py-4">{error}</p>
          )}
          {!loading && !error && summary && (
            <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-4 border border-slate-100 dark:border-slate-700/50">
              <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line">
                {summary}
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-3 flex items-center gap-1">
                <Sparkles size={10} /> Gegenereerd met AI · kan onnauwkeurigheden bevatten
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Artikel parsing (gedeeld) ──────────────────────────────────────────────
function parseArticle(a) {
  const fullAbstract = (a.abstractText || '').replace(/(<([^>]+)>)/gi, '');

  let authorsText = a.authorString || 'Auteurs onbekend';
  const arr = authorsText.split(', ');
  if (arr.length > 5) authorsText = arr.slice(0, 5).join(', ') + ', et al.';

  return {
    id:           a.pmid || a.id || `${a.source}-${a.title}`,
    title:        a.title || 'Geen titel beschikbaar',
    journal:      a.journalInfo?.journal?.title || a.journalTitle || 'Tijdschrift onbekend',
    date:         a.firstPublicationDate || a.pubYear || 'Datum onbekend',
    abstractFull: fullAbstract,
    authors:      authorsText,
    link:         `https://europepmc.org/article/${a.source || 'MED'}/${a.pmid || a.id}`,
    departments:  extractDepartments(a),
    _sortDate:    parseDate(a.firstPublicationDate || a.pubYear),
  };
}

// ── Hoofd component ────────────────────────────────────────────────────────
export default function App() {
  const [publications, setPublications]   = useState([]);
  const [loading, setLoading]             = useState(true);
  const [loadingMore, setLoadingMore]     = useState(false);
  const [error, setError]                 = useState(null);
  const [isDarkMode, setIsDarkMode]       = useState(false);
  const [cursorMark, setCursorMark]       = useState('*');
  const [hasMore, setHasMore]             = useState(false);
  const [searchTerm, setSearchTerm]       = useState('');
  const [selectedYear, setSelectedYear]   = useState('');
  const [selectedDept, setSelectedDept]   = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedYear, setAppliedYear]     = useState('');
  const [openProfile, setOpenProfile]     = useState(null);
  const [summaryPub, setSummaryPub]       = useState(null); // publicatie voor samenvatting-modal

  // Aparte state voor afdelingsfilter-resultaten
  const [deptPubs, setDeptPubs]             = useState([]);
  const [deptLoading, setDeptLoading]       = useState(false);
  const [deptLoadingMore, setDeptLoadingMore] = useState(false);
  const [deptCursor, setDeptCursor]         = useState('*');
  const [deptHasMore, setDeptHasMore]       = useState(false);

  // ── Beschikbare afdelingen ─────────────────────────────────────────────────
  const [knownDepts, setKnownDepts]         = useState(new Set());
  const [deptsScanned, setDeptsScanned]     = useState(false);

  // ── Eenmalige achtergrond-scan om alle afdelingen te ontdekken ────────────
  useEffect(() => {
    let cancelled = false;

    async function discoverDepartments() {
      try {
        const found = new Set();
        let cursor = '*';

        // Scan 3 pagina's van 100 (= 300 publicaties) — genoeg om vrijwel
        // alle actieve afdelingen te zien
        for (let page = 0; page < 3; page++) {
          const query = `(${BASE_QUERY})`;
          const data  = await epmc(query, 100, cursor);
          const articles = data.resultList?.result || [];

          for (const a of articles) {
            for (const d of extractDepartments(a)) {
              if (d !== 'Overig') found.add(d);
            }
          }

          if (data.nextCursorMark && data.nextCursorMark !== cursor && articles.length > 0) {
            cursor = data.nextCursorMark;
          } else {
            break;
          }
        }

        if (!cancelled) {
          setKnownDepts(found);
          setDeptsScanned(true);
        }
      } catch (e) {
        console.warn('Afdelingen-scan mislukt:', e);
        if (!cancelled) setDeptsScanned(true);
      }
    }

    discoverDepartments();
    return () => { cancelled = true; };
  }, []); // slechts één keer bij het opstarten

  // ── Reguliere publicaties ophalen (geen dept filter) ──────────────────────
  const fetchPublications = useCallback(async (isLoadMore = false, cursor = '*', searchStr = '', yearStr = '') => {
    try {
      if (isLoadMore) setLoadingMore(true);
      else { setLoading(true); setPublications([]); }
      setError(null);

      let query = `(${BASE_QUERY})`;
      if (searchStr) query += ` AND (${searchStr})`;
      if (yearStr)   query += ` AND (PUB_YEAR:${yearStr})`;

      const data     = await epmc(query, 12, cursor);
      const articles = data.resultList?.result || [];

      if (data.nextCursorMark && data.nextCursorMark !== cursor && articles.length > 0) {
        setCursorMark(data.nextCursorMark);
        setHasMore(true);
      } else {
        setHasMore(false);
      }

      const parsed = articles.map(parseArticle);

      setPublications(prev => {
        const combined = isLoadMore ? [...prev, ...parsed] : parsed;
        return [...combined].sort((a, b) => b._sortDate - a._sortDate);
      });
    } catch (err) {
      console.error(err);
      setError('Er is een fout opgetreden bij het ophalen van publicaties.');
    } finally {
      if (isLoadMore) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  // ── Afdeling-gefilterd ophalen ────────────────────────────────────────────
  // Haalt batches van 100 op uit EuropePMC en filtert client-side op afdeling
  // tot er minstens 12 resultaten zijn (of de API uitgeput is)
  const fetchDeptPublications = useCallback(async (dept, isLoadMore = false, startCursor = '*') => {
    try {
      if (isLoadMore) setDeptLoadingMore(true);
      else { setDeptLoading(true); setDeptPubs([]); }

      const TARGET = 12; // minimaal aantal resultaten per laadbeurt
      let cursor   = startCursor;
      let found    = isLoadMore ? [] : [];
      let apiDone  = false;
      let maxPages = 5; // veiligheidsgrens (5 × 100 = 500 publicaties)

      while (found.length < TARGET && !apiDone && maxPages > 0) {
        maxPages--;
        const query = `(${BASE_QUERY})`;
        const data  = await epmc(query, 100, cursor);
        const articles = data.resultList?.result || [];

        // Filter op afdeling
        for (const a of articles) {
          const depts = extractDepartments(a);
          if (depts.includes(dept)) {
            found.push(parseArticle(a));
          }
        }

        if (data.nextCursorMark && data.nextCursorMark !== cursor && articles.length > 0) {
          cursor = data.nextCursorMark;
        } else {
          apiDone = true;
        }
      }

      setDeptCursor(cursor);
      setDeptHasMore(!apiDone);

      setDeptPubs(prev => {
        const combined = isLoadMore ? [...prev, ...found] : found;
        return [...combined].sort((a, b) => b._sortDate - a._sortDate);
      });
    } catch (err) {
      console.error(err);
      setError('Er is een fout opgetreden bij het ophalen van publicaties.');
    } finally {
      if (isLoadMore) setDeptLoadingMore(false);
      else setDeptLoading(false);
    }
  }, []);

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    setCursorMark('*');
    setSelectedDept('');
    fetchPublications(false, '*', appliedSearch, appliedYear);
  }, [appliedSearch, appliedYear, fetchPublications]);

  // Wanneer een afdeling geselecteerd wordt → nieuwe fetch
  useEffect(() => {
    if (selectedDept) {
      fetchDeptPublications(selectedDept);
    }
  }, [selectedDept, fetchDeptPublications]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setAppliedSearch(searchTerm);
    setAppliedYear(selectedYear);
    setSelectedDept('');
  };

  const clearFilters = () => {
    setSearchTerm(''); setSelectedYear(''); setSelectedDept('');
    setAppliedSearch(''); setAppliedYear('');
  };

  // ── Welke publicaties tonen? ──────────────────────────────────────────────
  const availableDepts = useMemo(() => [...knownDepts].sort(), [knownDepts]);
  const displayPubs    = selectedDept ? deptPubs : publications;
  const isLoading      = selectedDept ? deptLoading : loading;
  const isLoadingMore  = selectedDept ? deptLoadingMore : loadingMore;
  const canLoadMore    = selectedDept ? deptHasMore : hasMore;

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 10 }, (_, i) => currentYear - i);
  const hasActiveFilters = appliedSearch || appliedYear || selectedDept;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-sans transition-colors duration-200">

      {openProfile && (
        <DeptProfileModal dept={openProfile} onClose={() => setOpenProfile(null)} />
      )}
      {summaryPub && (
        <SummaryModal pub={summaryPub} onClose={() => setSummaryPub(null)} />
      )}

      {/* ── Navigatie ── */}
      <nav className="bg-white px-4 md:px-8 py-3 flex justify-between items-center w-full border-b border-slate-200">
        <div className="max-w-6xl mx-auto w-full flex justify-between items-center">
          <a href="https://www.antoniusziekenhuis.nl" target="_blank" rel="noopener noreferrer">
            <img
              src="./st-antonius-logo.svg"
              alt="St. Antonius Ziekenhuis"
              className="h-9"
              onError={e => { e.target.onerror = null; e.target.style.display = 'none'; }}
            />
          </a>
          <button
            onClick={() => setIsDarkMode(d => !d)}
            className="p-2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            aria-label="Wissel weergave"
          >
            {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </div>
      </nav>

      {/* ── Header ── */}
      <header className="w-full flex flex-col">
        <div className="w-full py-5 px-4" style={{ backgroundColor: BRAND }}>
          <div className="max-w-6xl mx-auto text-center">
            <h1 className="text-2xl md:text-3xl lg:text-4xl text-white font-light tracking-wide">
              Publicaties Dashboard
            </h1>
            <p className="text-white/80 text-sm mt-1">St. Antonius Ziekenhuis · Nieuwegein / Utrecht</p>
          </div>
        </div>
        <div className="max-w-6xl mx-auto w-full px-4 py-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
          <span className="inline-flex items-center px-3 py-1.5 font-bold text-sm tracking-wide rounded text-white"
            style={{ backgroundColor: BRAND }}>
            Live Publicatie Dashboard
          </span>
          <p className="text-sm md:text-base text-slate-600 dark:text-slate-400 italic sm:border-l-2 sm:border-slate-300 dark:sm:border-slate-700 sm:pl-4">
            Actuele wetenschappelijke publicaties van medewerkers van het St. Antonius Ziekenhuis via Europe PMC.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-8 pb-16">

        {/* ── Zoek- & Filterbalk ── */}
        <div className="bg-white dark:bg-slate-800 p-4 md:p-5 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 mb-6">
          <form onSubmit={handleSearchSubmit} className="flex flex-col md:flex-row gap-4">
            <div className="flex-grow relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
              <input
                type="text" value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Zoek op auteur, titel, aandoening, trefwoord…"
                className="w-full pl-11 pr-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg outline-none transition-all text-slate-700 dark:text-slate-200"
              />
            </div>
            <div className="w-full md:w-44 relative shrink-0">
              <Filter className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
              <select
                value={selectedYear} onChange={e => setSelectedYear(e.target.value)}
                className="w-full pl-11 pr-8 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg outline-none appearance-none text-slate-700 dark:text-slate-200"
              >
                <option value="">Alle jaren</option>
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" size={16} />
            </div>
            <button
              type="submit"
              className="text-white px-7 py-2.5 rounded-lg font-medium transition-colors whitespace-nowrap shrink-0"
              style={{ backgroundColor: BRAND }}
              onMouseOver={e => e.currentTarget.style.backgroundColor = BRAND_DARK}
              onMouseOut={e => e.currentTarget.style.backgroundColor = BRAND}
            >
              Zoeken
            </button>
          </form>
        </div>

        {/* ── Afdeling filter ── */}
        {(availableDepts.length > 0 || !deptsScanned) && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">
              <Building2 size={16} />
              <span>Filter op afdeling</span>
              {selectedDept && (
                <button
                  onClick={() => setSelectedDept('')}
                  className="ml-1 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-white"
                  style={{ backgroundColor: BRAND }}
                >
                  {selectedDept} <X size={11} />
                </button>
              )}
              {selectedDept && (
                <button
                  onClick={() => setOpenProfile(selectedDept)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium transition-colors"
                  style={{ borderColor: BRAND, color: BRAND }}
                >
                  <BarChart2 size={11} /> Bekijk profiel
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {!deptsScanned && availableDepts.length === 0 && (
                <span className="inline-flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 size={14} className="animate-spin" /> Afdelingen detecteren…
                </span>
              )}
              {availableDepts.map(dept => {
                const isActive = selectedDept === dept;
                return (
                  <button
                    key={dept}
                    onClick={() => setSelectedDept(d => d === dept ? '' : dept)}
                    className="inline-flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-full border transition-all font-medium"
                    style={isActive
                      ? { backgroundColor: BRAND, borderColor: BRAND, color: '#fff' }
                      : { backgroundColor: 'transparent', borderColor: BRAND, color: BRAND }
                    }
                  >
                    {dept}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Sectieheader ── */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl md:text-2xl font-semibold flex items-center gap-2 dark:text-white">
            <BookOpen size={24} style={{ color: BRAND }} />
            {hasActiveFilters ? 'Gefilterde publicaties' : 'Recente publicaties'}
            {selectedDept && (
              <span className="text-base font-normal text-slate-500 dark:text-slate-400">
                — {selectedDept}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-3">
            {hasActiveFilters && (
              <button onClick={clearFilters}
                className="text-sm font-medium hover:underline text-slate-500 dark:text-slate-400">
                Wis filters
              </button>
            )}
            <span className="text-xs md:text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-200 dark:bg-slate-800 px-3 py-1 rounded-full border border-slate-300 dark:border-slate-700 hidden sm:inline-block">
              Live via Europe PMC
            </span>
          </div>
        </div>

        {/* ── Laadstatus ── */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-20 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700">
            <Loader2 size={48} className="animate-spin mb-4" style={{ color: BRAND }} />
            <p className="text-slate-500 dark:text-slate-400 font-medium">
              {selectedDept ? `Publicaties ophalen voor ${selectedDept}…` : 'Publicaties ophalen…'}
            </p>
          </div>
        )}

        {!isLoading && error && (
          <div className="flex items-center gap-3 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 p-5 rounded-xl border border-red-200 dark:border-red-800">
            <AlertCircle size={24} />
            <p className="font-medium">{error}</p>
          </div>
        )}

        {!isLoading && !error && displayPubs.length === 0 && (
          <div className="text-center py-20 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700">
            <FileText size={48} className="text-slate-300 dark:text-slate-600 mx-auto mb-4" />
            <p className="text-slate-500 dark:text-slate-400 font-medium">Geen publicaties gevonden.</p>
            <button onClick={clearFilters} className="mt-4 text-sm font-medium hover:underline" style={{ color: BRAND }}>
              Filters wissen
            </button>
          </div>
        )}

        {/* ── Publicaties grid ── */}
        {!isLoading && !error && displayPubs.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {displayPubs.map(pub => (
                <div key={pub.id}
                  className="bg-white dark:bg-slate-800 rounded-xl shadow-sm hover:shadow-md transition-all duration-200 border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden">
                  <div className="p-5 flex-grow">
                    <div className="flex justify-between items-start mb-2 gap-2">
                      <div className="text-xs font-bold uppercase tracking-wider line-clamp-1"
                        style={{ color: BRAND }} title={pub.journal}>
                        {pub.journal}
                      </div>
                      <div className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0 bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded">
                        <Calendar size={12} />
                        {pub.date}
                      </div>
                    </div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mb-3 leading-snug line-clamp-3">
                      {pub.title}
                    </h3>
                    <div className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-400 mb-3">
                      <Users size={15} className="shrink-0 mt-0.5" />
                      <p className="line-clamp-2">{pub.authors}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {pub.departments.filter(d => d !== 'Overig').map(d => (
                        <button key={d}
                          onClick={() => setSelectedDept(d)}
                          className="text-xs px-2 py-0.5 rounded-full border transition-colors"
                          style={{ borderColor: BRAND, color: BRAND }}
                          title={`Filter op ${d}`}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="px-5 py-4 border-t border-slate-100 dark:border-slate-700 mt-auto flex gap-2">
                    {anthropic && (
                      <button
                        onClick={() => setSummaryPub(pub)}
                        className="inline-flex items-center justify-center gap-1.5 text-sm font-medium py-2.5 px-3 rounded-lg border transition-colors"
                        style={{ borderColor: BRAND, color: BRAND }}
                        onMouseOver={e => { e.currentTarget.style.backgroundColor = BRAND; e.currentTarget.style.color = '#fff'; }}
                        onMouseOut={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = BRAND; }}
                        title="Genereer een publieksvriendelijke samenvatting met AI"
                      >
                        <Sparkles size={14} />
                        Samenvatting
                      </button>
                    )}
                    <a href={pub.link} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center justify-center flex-1 gap-2 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                      style={{ backgroundColor: BRAND }}
                      onMouseOver={e => e.currentTarget.style.backgroundColor = BRAND_DARK}
                      onMouseOut={e => e.currentTarget.style.backgroundColor = BRAND}>
                      Europe PMC
                      <ExternalLink size={15} />
                    </a>
                  </div>
                </div>
              ))}
            </div>

            {canLoadMore && (
              <div className="mt-12 flex justify-center">
                <button
                  onClick={() => {
                    if (selectedDept) {
                      fetchDeptPublications(selectedDept, true, deptCursor);
                    } else {
                      fetchPublications(true, cursorMark, appliedSearch, appliedYear);
                    }
                  }}
                  disabled={isLoadingMore}
                  className="flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 px-6 py-3 rounded-full font-semibold shadow-sm hover:shadow hover:bg-slate-50 dark:hover:bg-slate-700 transition-all disabled:opacity-70"
                >
                  {isLoadingMore
                    ? <><Loader2 size={18} className="animate-spin" /> Artikelen laden…</>
                    : <>Meer artikelen laden <ChevronDown size={18} /></>
                  }
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 py-6 text-center text-xs text-slate-400 dark:text-slate-600">
        Publicatiedata via{' '}
        <a href="https://europepmc.org" target="_blank" rel="noopener noreferrer"
          className="hover:underline" style={{ color: BRAND }}>
          Europe PubMed Central
        </a>
        {' '}· St. Antonius Ziekenhuis, Nieuwegein / Utrecht
      </footer>
    </div>
  );
}
