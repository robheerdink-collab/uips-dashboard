import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import {
  ExternalLink, BookOpen, Users, FileText, AlertCircle,
  Loader2, Moon, Sun, Calendar, ChevronDown, Search,
  Building2, X, Filter, BarChart2, Tag, Newspaper, Sparkles, User
} from 'lucide-react';

// ── Brand colours (UIPS / Utrecht University) ─────────────────────────────
const BRAND      = '#FFCD00';   // UU yellow – used for backgrounds
const BRAND_DARK = '#E6B800';   // darker yellow – hover state
const BRAND_TEXT = '#000000';   // black – text/borders on light backgrounds

// ── Anthropic client (optioneel, alleen als key beschikbaar) ───────────────
const anthropic = import.meta.env.VITE_ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY, dangerouslyAllowBrowser: true })
  : null;

// ── Summary cache (localStorage) ──────────────────────────────────────────
const SUMMARY_CACHE_KEY = 'uips-summaries';
const readSummaryCache = () => {
  try { return JSON.parse(localStorage.getItem(SUMMARY_CACHE_KEY) || '{}'); }
  catch { return {}; }
};
const writeSummaryCache = (cache) => {
  try { localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(cache)); }
  catch { /* full — skip */ }
};

// ── SDG cache (localStorage) ──────────────────────────────────────────────
const SDG_CACHE_KEY = 'uips-sdgs-v4'; // v4: expanded search query surfaces new papers
const readSdgCache = () => {
  try { return JSON.parse(localStorage.getItem(SDG_CACHE_KEY) || '{}'); }
  catch { return {}; }
};
const writeSdgCache = (cache) => {
  try { localStorage.setItem(SDG_CACHE_KEY, JSON.stringify(cache)); }
  catch { /* full — skip */ }
};

// ── SDG labels (1-17) ─────────────────────────────────────────────────────
const SDG_LABELS = {
  1: 'No Poverty', 2: 'Zero Hunger', 3: 'Good Health and Well-being',
  4: 'Quality Education', 5: 'Gender Equality', 6: 'Clean Water and Sanitation',
  7: 'Affordable and Clean Energy', 8: 'Decent Work and Economic Growth',
  9: 'Industry, Innovation and Infrastructure', 10: 'Reduced Inequalities',
  11: 'Sustainable Cities and Communities', 12: 'Responsible Consumption and Production',
  13: 'Climate Action', 14: 'Life Below Water', 15: 'Life on Land',
  16: 'Peace, Justice and Strong Institutions', 17: 'Partnerships for the Goals',
};
const sdgIconUrl = n =>
  `${import.meta.env.BASE_URL}E-WEB-Goal-${String(n).padStart(2, '0')}.png`;

// ── EuropePMC search query ────────────────────────────────────────────────
// Matches: "UIPS" anywhere in affiliation, OR "Utrecht Institute" + "pharmaceutical science(s)"
const BASE_QUERY =
  `(AFF:("UIPS") OR (AFF:("Utrecht Institute") AND AFF:("pharmaceutical sciences")))`;

// ── UIPS affiliation check (local, on fetched articles) ───────────────────
// An affiliation is UIPS-related if it contains "uips" OR
// ("utrecht institute" AND "pharmaceutical science")
function isUIPSAffiliation(aff) {
  const a = aff.toLowerCase();
  return a.includes('uips') ||
         (a.includes('utrecht institute') && a.includes('pharmaceutical science'));
}

// ── Division assignment ────────────────────────────────────────────────────
// Rules applied in order; pharmacoepidemiology checked before generic pharmacology
function affiliationToDivision(aff) {
  const a = aff.toLowerCase();
  if (a.includes('pharmacoepidemiol'))
    return 'Pharmacoepidemiology & Clinical Pharmacology';
  if (a.includes('spectrometry') || a.includes('proteomics'))
    return 'Biomolecular Mass Spectrometry and Proteomics';
  if (a.includes('chemical biology') || a.includes('drug discovery'))
    return 'Chemical Biology and Drug Discovery';
  if (a.includes('pharmaceutics'))
    return 'Pharmaceutics';
  if (a.includes('pharmacology'))
    return 'Pharmacology';
  return 'Division not listed';
}

function extractDepartments(article) {
  const authors = article.authorList?.author || [];
  const found = new Set();
  for (const author of authors) {
    const affs = author.authorAffiliationDetailsList?.authorAffiliation || [];
    for (const { affiliation: aff = '' } of affs) {
      if (!isUIPSAffiliation(aff)) continue;
      found.add(affiliationToDivision(aff));
    }
  }
  return found.size > 0 ? [...found] : ['Division not listed'];
}

function extractUIPSAuthors(article) {
  const result = [];
  for (const author of article.authorList?.author || []) {
    const affs = author.authorAffiliationDetailsList?.authorAffiliation || [];
    if (affs.some(a => isUIPSAffiliation(a.affiliation || '')) && author.fullName) {
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
        // Haal per jaar de publicaties op (2000 t/m huidig jaar) in parallel
        const thisYear = new Date().getFullYear();
        const years    = Array.from({ length: thisYear - 1999 }, (_, i) => 2000 + i);

        const perYear = await Promise.all(
          years.map(async year => {
            try {
              const q = `(${BASE_QUERY}) AND PUB_YEAR:${year}`;
              const data = await epmc(q, 1000);
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

          for (const name of extractUIPSAuthors(a))
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

        // Year chart (only years with ≥1 publication + adjacent years)
        const activeYears = perYear.filter(p => p.articles.length > 0);
        const firstYear   = activeYears[0]?.year ?? thisYear;
        const yearChartData = perYear
          .filter(p => p.year >= firstYear)
          .map(p => ({ label: String(p.year), value: p.articles.length }));

        // Recent publications (most recent first)
        const recentPubs = [...allArticles]
          .sort((a, b) => parseDate(b.firstPublicationDate || b.pubYear) - parseDate(a.firstPublicationDate || a.pubYear))
          .slice(0, 4)
          .map(a => ({
            id:    a.pmid || a.id,
            title: cleanHtml(a.title) || 'No title',
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
        if (!cancelled) setError('Could not fetch statistics.');
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
            <h2 className="text-xl font-bold" style={{ color: BRAND_TEXT }}>{dept}</h2>
            <p className="text-sm mt-0.5" style={{ color: BRAND_TEXT, opacity: 0.7 }}>UIPS · Utrecht University</p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center transition-colors"
            style={{ backgroundColor: 'rgba(0,0,0,0.12)', color: BRAND_TEXT }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {loading && (
            <div className="flex flex-col items-center py-16">
              <Loader2 size={36} className="animate-spin mb-3" style={{ color: BRAND_TEXT }} />
              <p className="text-slate-500 dark:text-slate-400 text-sm">
                Fetching statistics per year…
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
                  <div className="text-3xl font-bold" style={{ color: BRAND_TEXT }}>
                    {stats.cappedPerYear ? `${stats.count}+` : stats.count}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">Publications found</div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 text-center">
                  <div className="text-3xl font-bold" style={{ color: BRAND_TEXT }}>
                    {stats.minYear !== stats.maxYear
                      ? `${stats.minYear}–${stats.maxYear}`
                      : stats.minYear}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">Active years</div>
                </div>
              </div>

              {/* Bar chart */}
              {stats.yearChartData.length > 0 && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <BarChart2 size={16} style={{ color: BRAND_TEXT }} />
                    Publications per year
                  </h3>
                  <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4">
                    <BarChart data={stats.yearChartData} color={BRAND} />
                  </div>
                  {stats.cappedPerYear && (
                    <p className="text-xs text-slate-400 mt-1">
                      * Numbers are capped at 100 per year (sample)
                    </p>
                  )}
                </div>
              )}

              {/* Top Journals & Topics */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {stats.topJournals.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                      <Newspaper size={16} style={{ color: BRAND_TEXT }} />
                      Top Journals
                    </h3>
                    <ul className="space-y-2">
                      {stats.topJournals.map(([journal, count]) => (
                        <li key={journal} className="flex items-center justify-between gap-2">
                          <span className="text-sm text-slate-600 dark:text-slate-300 line-clamp-1 flex-1" title={journal}>
                            {journal}
                          </span>
                          <span className="shrink-0 w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center"
                            style={{ backgroundColor: BRAND, color: BRAND_TEXT }}>
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
                      <Tag size={16} style={{ color: BRAND_TEXT }} />
                      Top Topics
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {stats.topTopics.map(([topic, count]) => (
                        <span key={topic}
                          className="text-xs px-2.5 py-1 rounded-full border font-medium border-black text-slate-700 dark:border-slate-400 dark:text-slate-300">
                          {topic} <span className="opacity-60">({count})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Most frequent authors */}
              {stats.topAuthors.length > 0 && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <Users size={16} style={{ color: BRAND_TEXT }} />
                    Most frequent authors
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {stats.topAuthors.map(([author, count]) => (
                      <span key={author}
                        className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-full">
                        {author}
                        <span className="text-xs font-bold px-1.5 py-0.5 rounded-full"
                          style={{ backgroundColor: BRAND, color: BRAND_TEXT }}>{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent publications */}
              {stats.recentPubs.length > 0 && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <BookOpen size={16} style={{ color: BRAND_TEXT }} />
                    Recent publications
                  </h3>
                  <ul className="space-y-1">
                    {stats.recentPubs.map(pub => (
                      <li key={pub.id}>
                        <a href={pub.link} target="_blank" rel="noopener noreferrer"
                          className="flex items-start gap-2 group hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg p-2 -mx-2 transition-colors">
                          <ExternalLink size={14} className="shrink-0 mt-0.5 opacity-40 group-hover:opacity-100 transition-opacity text-slate-500" />
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

// ── Author Profile Modal ──────────────────────────────────────────────────
function AuthorProfileModal({ author, onClose }) {
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true); setError(null);
      try {
        const thisYear = new Date().getFullYear();
        const years    = Array.from({ length: thisYear - 1999 }, (_, i) => 2000 + i);

        const perYear = await Promise.all(
          years.map(async year => {
            try {
              const q = `AUTH:"${author}" AND PUB_YEAR:${year}`;
              const data = await epmc(q, 1000);
              return { year, articles: data.resultList?.result || [] };
            } catch { return { year, articles: [] }; }
          })
        );

        if (cancelled) return;

        const allArticles = perYear.flatMap(p => p.articles);

        const journalCounts = {};
        const topicCounts   = {};
        const coauthorCounts = {};

        for (const a of allArticles) {
          const journal = a.journalInfo?.journal?.title || a.journalTitle || '';
          if (journal) journalCounts[journal] = (journalCounts[journal] || 0) + 1;

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

          // Co-auteurs: alle auteurs behalve de auteur zelf
          const coAuthors = (a.authorString || '').split(', ').filter(Boolean);
          for (const co of coAuthors) {
            if (!author.toLowerCase().includes(co.split(' ')[0].toLowerCase()) &&
                !co.toLowerCase().includes(author.split(' ')[0].toLowerCase())) {
              coauthorCounts[co] = (coauthorCounts[co] || 0) + 1;
            }
          }
        }

        const activeYears = perYear.filter(p => p.articles.length > 0);
        const firstYear   = activeYears[0]?.year ?? thisYear;
        const yearChartData = perYear
          .filter(p => p.year >= firstYear)
          .map(p => ({ label: String(p.year), value: p.articles.length }));

        const recentPubs = [...allArticles]
          .sort((a, b) => parseDate(b.firstPublicationDate || b.pubYear) - parseDate(a.firstPublicationDate || a.pubYear))
          .slice(0, 4)
          .map(a => ({
            id:   a.pmid || a.id,
            title: cleanHtml(a.title) || 'No title',
            date:  a.firstPublicationDate || a.pubYear || '',
            link:  `https://europepmc.org/article/${a.source || 'MED'}/${a.pmid || a.id}`,
          }));

        const minYear = firstYear;
        const maxYear = activeYears[activeYears.length - 1]?.year ?? thisYear;

        setStats({
          count: allArticles.length,
          minYear, maxYear,
          yearChartData,
          topJournals:  Object.entries(journalCounts).sort((a, b) => b[1] - a[1]).slice(0, 5),
          topCoauthors: Object.entries(coauthorCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
          topTopics:    Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
          recentPubs,
        });
      } catch (e) {
        if (!cancelled) setError('Could not fetch statistics.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [author]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl bg-white dark:bg-slate-800 rounded-2xl shadow-2xl my-8 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between" style={{ backgroundColor: BRAND }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.12)' }}>
              <User size={20} style={{ color: BRAND_TEXT }} />
            </div>
            <div>
              <h2 className="text-xl font-bold" style={{ color: BRAND_TEXT }}>{author}</h2>
              <p className="text-sm mt-0.5" style={{ color: BRAND_TEXT, opacity: 0.7 }}>UIPS · Utrecht University · Publication Profile</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center transition-colors"
            style={{ backgroundColor: 'rgba(0,0,0,0.12)', color: BRAND_TEXT }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {loading && (
            <div className="flex flex-col items-center py-16">
              <Loader2 size={36} className="animate-spin mb-3" style={{ color: BRAND_TEXT }} />
              <p className="text-slate-500 dark:text-slate-400 text-sm">Fetching publications per year…</p>
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
                  <div className="text-3xl font-bold text-slate-900 dark:text-slate-100">{stats.count}</div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">Publications (UIPS)</div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 text-center">
                  <div className="text-3xl font-bold text-slate-900 dark:text-slate-100">
                    {stats.count === 0 ? '–' : stats.minYear !== stats.maxYear
                      ? `${stats.minYear}–${stats.maxYear}`
                      : stats.minYear}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">Active years</div>
                </div>
              </div>

              {/* No publications */}
              {stats.count === 0 && (
                <p className="text-slate-500 dark:text-slate-400 text-sm text-center py-4">
                  No UIPS publications found for this author.
                </p>
              )}

              {/* Bar chart */}
              {stats.yearChartData.some(d => d.value > 0) && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <BarChart2 size={16} style={{ color: BRAND_TEXT }} />
                    Publications per year
                  </h3>
                  <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4">
                    <BarChart data={stats.yearChartData} color={BRAND} />
                  </div>
                </div>
              )}

              {/* Top Journals & Topics */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {stats.topJournals.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                      <Newspaper size={16} style={{ color: BRAND_TEXT }} />
                      Top Journals
                    </h3>
                    <ul className="space-y-2">
                      {stats.topJournals.map(([journal, count]) => (
                        <li key={journal} className="flex items-center justify-between gap-2">
                          <span className="text-sm text-slate-600 dark:text-slate-300 line-clamp-1 flex-1" title={journal}>
                            {journal}
                          </span>
                          <span className="shrink-0 w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center"
                            style={{ backgroundColor: BRAND, color: BRAND_TEXT }}>{count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {stats.topTopics.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                      <Tag size={16} style={{ color: BRAND_TEXT }} />
                      Top Topics
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {stats.topTopics.map(([topic, count]) => (
                        <span key={topic}
                          className="text-xs px-2.5 py-1 rounded-full border font-medium border-black text-slate-700 dark:border-slate-400 dark:text-slate-300">
                          {topic} <span className="opacity-60">({count})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Most frequent co-authors */}
              {stats.topCoauthors.length > 0 && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <Users size={16} style={{ color: BRAND_TEXT }} />
                    Most frequent co-authors
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {stats.topCoauthors.map(([co, count]) => (
                      <span key={co}
                        className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-full">
                        {co}
                        <span className="text-xs font-bold px-1.5 py-0.5 rounded-full"
                          style={{ backgroundColor: BRAND, color: BRAND_TEXT }}>{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent publications */}
              {stats.recentPubs.length > 0 && (
                <div>
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                    <BookOpen size={16} style={{ color: BRAND_TEXT }} />
                    Recent publications
                  </h3>
                  <ul className="space-y-1">
                    {stats.recentPubs.map(pub => (
                      <li key={pub.id}>
                        <a href={pub.link} target="_blank" rel="noopener noreferrer"
                          className="flex items-start gap-2 group hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg p-2 -mx-2 transition-colors">
                          <ExternalLink size={14} className="shrink-0 mt-0.5 opacity-40 group-hover:opacity-100 transition-opacity text-slate-500" />
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

// ── Public Summary Modal ───────────────────────────────────────────────────
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
        setError('No API key configured. Set VITE_ANTHROPIC_API_KEY.');
        setLoading(false);
        return;
      }

      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `You are a science communicator. Write a clear public summary in English (max 150 words) of the following scientific article from the Utrecht Institute for Pharmaceutical Sciences (UIPS). Use accessible language, avoid jargon, and explain why this research matters for patients or society.

Title: ${pub.title}
Journal: ${pub.journal}
Division: ${pub.departments?.filter(d => d !== 'Division not listed').join(', ') || 'Unknown'}
Abstract: ${pub.abstractFull || pub.abstract || 'Not available'}

Write only the summary, no introduction or title.`
          }]
        });

        const text = response.content.find(b => b.type === 'text')?.text || '';

        if (!cancelled) {
          setSummary(text);
          // Save to cache
          const c = readSummaryCache();
          c[pub.id] = text;
          writeSummaryCache(c);
        }
      } catch (e) {
        console.error('Summary error:', e);
        if (!cancelled) setError('Could not generate the summary. Please try again later.');
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
          <div className="flex items-center gap-2" style={{ color: BRAND_TEXT }}>
            <Sparkles size={18} />
            <h3 className="font-semibold text-sm">Public Summary</h3>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.12)', color: BRAND_TEXT }}>
            <X size={16} />
          </button>
        </div>
        {/* Title */}
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
              <Loader2 size={20} className="animate-spin text-slate-400" />
              <span className="text-sm text-slate-500 dark:text-slate-400">Generating summary…</span>
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
                <Sparkles size={10} /> Generated with AI · may contain inaccuracies
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── SDG Badges component ──────────────────────────────────────────────────
function SdgBadges({ pub }) {
  const [sdgs, setSdgs] = useState(undefined); // undefined = loading

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // 1. Check cache first
      const cache = readSdgCache();
      if (cache[pub.id] !== undefined) {
        setSdgs(cache[pub.id]);
        return;
      }
      // 2. No API key → show nothing, do NOT cache so we retry when key is available
      if (!anthropic) {
        setSdgs([]);
        return;
      }
      // 3. Call Haiku
      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 60,
          messages: [{
            role: 'user',
            content:
              `You classify pharmaceutical sciences publications into UN SDGs.\n\n` +
              `RULES (follow strictly):\n` +
              `1. ALWAYS include SDG 3 — virtually all pharma/health research qualifies.\n` +
              `2. Returning just [3] is CORRECT and EXPECTED for most papers. Do NOT force extra SDGs.\n` +
              `3. Only add ONE extra SDG if the abstract EXPLICITLY discusses one of these:\n` +
              `   - SDG 2: the paper is about nutrition, food safety, or hunger\n` +
              `   - SDG 6: the paper is about water quality or sanitation\n` +
              `   - SDG 10: the paper explicitly studies health disparities or access to medicines in low-income countries\n` +
              `   - SDG 12: the paper is about green/sustainable chemistry or pharmaceutical waste reduction\n` +
              `   - SDG 14/15: the paper is about environmental or ecological toxicology\n` +
              `4. Do NOT assign:\n` +
              `   - SDG 5 unless the paper explicitly studies gender-specific health outcomes\n` +
              `   - SDG 9 for lab methods, new materials, or novel assays — that is normal research, not infrastructure\n` +
              `   - SDG 17 for papers that merely have international co-authors\n\n` +
              `Respond with ONLY a JSON array. Example: [3] or [3,10]\n\n` +
              `Title: ${pub.title}\n` +
              `Abstract: ${(pub.abstractFull || '').slice(0, 800) || 'Not available'}`,
          }],
        });
        const text = response.content.find(b => b.type === 'text')?.text || '[]';
        const match = text.match(/\[[\d,\s]*\]/);
        const nums = match
          ? JSON.parse(match[0]).filter(n => Number.isInteger(n) && n >= 1 && n <= 17).slice(0, 3)
          : [3]; // fallback: SDG 3 always applies to UIPS research
        if (!cancelled) {
          setSdgs(nums);
          // Only cache non-empty results so failed/keyless attempts are retried
          if (nums.length > 0) {
            const c = readSdgCache();
            c[pub.id] = nums;
            writeSdgCache(c);
          }
        }
      } catch {
        if (!cancelled) setSdgs([]);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [pub.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Still loading → small skeleton dots
  if (sdgs === undefined) {
    return (
      <div className="flex gap-1 mt-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="w-7 h-7 rounded bg-slate-200 dark:bg-slate-700 animate-pulse" />
        ))}
      </div>
    );
  }
  if (!sdgs.length) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {sdgs.map(n => (
        <img
          key={n}
          src={sdgIconUrl(n)}
          alt={`SDG ${n}`}
          title={`SDG ${n}: ${SDG_LABELS[n]}`}
          className="w-8 h-8 rounded object-cover"
        />
      ))}
    </div>
  );
}

// ── Clean HTML ─────────────────────────────────────────────────────────────
function cleanHtml(str) {
  if (!str) return '';
  // Decode HTML entities (&lt; → <, &amp; → &, &#39; → ', etc.)
  const txt = new DOMParser().parseFromString(str, 'text/html').body.textContent || '';
  // Strip any remaining HTML tags
  return txt.replace(/<[^>]+>/g, '');
}

// ── Artikel parsing (gedeeld) ──────────────────────────────────────────────
function parseArticle(a) {
  const fullAbstract = cleanHtml(a.abstractText);

  const allAuthors = (a.authorString || '').split(', ').filter(Boolean);
  const authorNames    = allAuthors.slice(0, 5);
  const hasMoreAuthors = allAuthors.length > 5;

  return {
    id:             a.pmid || a.id || `${a.source}-${a.title}`,
    title:          cleanHtml(a.title) || 'Geen titel beschikbaar',
    journal:        a.journalInfo?.journal?.title || a.journalTitle || 'Tijdschrift onbekend',
    date:           a.firstPublicationDate || a.pubYear || 'Datum onbekend',
    abstractFull:   fullAbstract,
    authors:        authorNames.join(', ') + (hasMoreAuthors ? ', et al.' : ''),
    authorNames,
    hasMoreAuthors,
    link:           `https://europepmc.org/article/${a.source || 'MED'}/${a.pmid || a.id}`,
    departments:    extractDepartments(a),
    _sortDate:      parseDate(a.firstPublicationDate || a.pubYear),
  };
}

// ── Main component ────────────────────────────────────────────────────────
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
  const [authorProfile, setAuthorProfile] = useState(null);
  const [summaryPub, setSummaryPub]       = useState(null);

  // Separate state for division-filtered results
  const [deptPubs, setDeptPubs]             = useState([]);
  const [deptLoading, setDeptLoading]       = useState(false);
  const [deptLoadingMore, setDeptLoadingMore] = useState(false);
  const [deptCursor, setDeptCursor]         = useState('*');
  const [deptHasMore, setDeptHasMore]       = useState(false);

  // ── Available divisions ────────────────────────────────────────────────────
  const [knownDepts, setKnownDepts]         = useState(new Set());
  const [deptsScanned, setDeptsScanned]     = useState(false);

  // ── One-time background scan to discover all divisions ────────────────────
  useEffect(() => {
    let cancelled = false;

    async function discoverDepartments() {
      try {
        const found = new Set();
        let cursor = '*';

        // Scan 3 pages of 100 (= 300 publications) — enough to find all active divisions
        for (let page = 0; page < 3; page++) {
          const query = `(${BASE_QUERY})`;
          const data  = await epmc(query, 100, cursor);
          const articles = data.resultList?.result || [];

          for (const a of articles) {
            for (const d of extractDepartments(a)) {
              found.add(d);
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
        console.warn('Division scan failed:', e);
        if (!cancelled) setDeptsScanned(true);
      }
    }

    discoverDepartments();
    return () => { cancelled = true; };
  }, []); // runs once on startup

  // ── Fetch regular publications (no division filter) ───────────────────────
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
      setError('An error occurred while fetching publications.');
    } finally {
      if (isLoadMore) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  // ── Fetch division-filtered publications ──────────────────────────────────
  // Fetches batches of 100 from EuropePMC and filters client-side by division
  // until at least 12 results are found (or the API is exhausted)
  const fetchDeptPublications = useCallback(async (dept, isLoadMore = false, startCursor = '*') => {
    try {
      if (isLoadMore) setDeptLoadingMore(true);
      else { setDeptLoading(true); setDeptPubs([]); }

      const TARGET = 12; // minimum results per load
      let cursor   = startCursor;
      let found    = isLoadMore ? [] : [];
      let apiDone  = false;
      let maxPages = 5; // safety limit (5 × 100 = 500 publications)

      while (found.length < TARGET && !apiDone && maxPages > 0) {
        maxPages--;
        const query = `(${BASE_QUERY})`;
        const data  = await epmc(query, 100, cursor);
        const articles = data.resultList?.result || [];

        // Filter by division
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
      setError('An error occurred while fetching publications.');
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

  // When a division is selected → new fetch
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

  // ── Which publications to show? ───────────────────────────────────────────
  const availableDepts = useMemo(() => {
    const named = [...knownDepts].filter(d => d !== 'Division not listed').sort();
    const hasUnlisted = knownDepts.has('Division not listed');
    return { named, hasUnlisted };
  }, [knownDepts]);
  const displayPubs    = selectedDept ? deptPubs : publications;
  const isLoading      = selectedDept ? deptLoading : loading;
  const isLoadingMore  = selectedDept ? deptLoadingMore : loadingMore;
  const canLoadMore    = selectedDept ? deptHasMore : hasMore;

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: currentYear - 1999 }, (_, i) => currentYear - i);
  const hasActiveFilters = appliedSearch || appliedYear || selectedDept;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-sans transition-colors duration-200">

      {openProfile && (
        <DeptProfileModal dept={openProfile} onClose={() => setOpenProfile(null)} />
      )}
      {authorProfile && (
        <AuthorProfileModal author={authorProfile} onClose={() => setAuthorProfile(null)} />
      )}
      {summaryPub && (
        <SummaryModal pub={summaryPub} onClose={() => setSummaryPub(null)} />
      )}

      {/* ── Navigatie ── */}
      <nav className="bg-white px-4 md:px-8 py-3 flex justify-between items-center w-full border-b border-slate-200">
        <div className="max-w-6xl mx-auto w-full flex justify-between items-center">
          <a href="https://www.uu.nl/en/research/utrecht-institute-for-pharmaceutical-sciences" target="_blank" rel="noopener noreferrer">
            <img
              src="./uips-logo.svg"
              alt="Utrecht Institute for Pharmaceutical Sciences"
              className="h-9"
              onError={e => { e.target.onerror = null; e.target.style.display = 'none'; }}
            />
          </a>
          <button
            onClick={() => setIsDarkMode(d => !d)}
            className="p-2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            aria-label="Toggle display"
          >
            {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </div>
      </nav>

      {/* ── Header ── */}
      <header className="w-full flex flex-col">
        <div className="w-full py-5 px-4" style={{ backgroundColor: BRAND }}>
          <div className="max-w-6xl mx-auto text-center">
            <h1 className="text-2xl md:text-3xl lg:text-4xl font-light tracking-wide" style={{ color: BRAND_TEXT }}>
              Publications Dashboard
            </h1>
            <p className="text-sm mt-1" style={{ color: BRAND_TEXT, opacity: 0.7 }}>Utrecht Institute for Pharmaceutical Sciences · Utrecht University</p>
          </div>
        </div>
        <div className="max-w-6xl mx-auto w-full px-4 py-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
          <span className="inline-flex items-center px-3 py-1.5 font-bold text-sm tracking-wide rounded"
            style={{ backgroundColor: BRAND, color: BRAND_TEXT }}>
            Live Publication Dashboard
          </span>
          <p className="text-sm md:text-base text-slate-600 dark:text-slate-400 italic sm:border-l-2 sm:border-slate-300 dark:sm:border-slate-700 sm:pl-4">
            Current scientific publications from researchers at the Utrecht Institute for Pharmaceutical Sciences via Europe PMC.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-8 pb-16">

        {/* ── Search & Filter bar ── */}
        <div className="bg-white dark:bg-slate-800 p-4 md:p-5 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 mb-6">
          <form onSubmit={handleSearchSubmit} className="flex flex-col md:flex-row gap-4">
            <div className="flex-grow relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
              <input
                type="text" value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search by author, title, disease, keyword…"
                className="w-full pl-11 pr-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg outline-none transition-all text-slate-700 dark:text-slate-200"
              />
            </div>
            <div className="w-full md:w-44 relative shrink-0">
              <Filter className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
              <select
                value={selectedYear} onChange={e => setSelectedYear(e.target.value)}
                className="w-full pl-11 pr-8 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg outline-none appearance-none text-slate-700 dark:text-slate-200"
              >
                <option value="">All years</option>
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" size={16} />
            </div>
            <button
              type="submit"
              className="font-bold px-7 py-2.5 rounded-lg transition-colors whitespace-nowrap shrink-0"
              style={{ backgroundColor: BRAND, color: BRAND_TEXT }}
              onMouseOver={e => e.currentTarget.style.backgroundColor = BRAND_DARK}
              onMouseOut={e => e.currentTarget.style.backgroundColor = BRAND}
            >
              Search
            </button>
          </form>
        </div>

        {/* ── Division filter ── */}
        {(availableDepts.named.length > 0 || availableDepts.hasUnlisted || !deptsScanned) && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">
              <Building2 size={16} />
              <span>Filter by division</span>
              {selectedDept && (
                <button
                  onClick={() => setSelectedDept('')}
                  className="ml-1 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-bold"
                  style={{ backgroundColor: BRAND, color: BRAND_TEXT }}
                >
                  {selectedDept} <X size={11} />
                </button>
              )}
              {selectedDept && (
                <button
                  onClick={() => setOpenProfile(selectedDept)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-black font-medium transition-colors text-slate-700 dark:border-slate-400 dark:text-slate-300"
                >
                  <BarChart2 size={11} /> View profile
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {!deptsScanned && availableDepts.named.length === 0 && !availableDepts.hasUnlisted && (
                <span className="inline-flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 size={14} className="animate-spin" /> Detecting divisions…
                </span>
              )}
              {availableDepts.named.map(dept => {
                const isActive = selectedDept === dept;
                return (
                  <button
                    key={dept}
                    onClick={() => setSelectedDept(d => d === dept ? '' : dept)}
                    className="inline-flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-full border transition-all font-medium"
                    style={isActive
                      ? { backgroundColor: BRAND, borderColor: BRAND, color: BRAND_TEXT }
                      : { backgroundColor: 'transparent', borderColor: '#000', color: '#000' }
                    }
                  >
                    {dept}
                  </button>
                );
              })}
              {availableDepts.hasUnlisted && (
                <>
                  <span className="w-px self-stretch bg-slate-300 dark:bg-slate-600 mx-1" />
                  <button
                    onClick={() => setSelectedDept(d => d === 'Division not listed' ? '' : 'Division not listed')}
                    className="inline-flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-full border transition-all font-medium"
                    style={selectedDept === 'Division not listed'
                      ? { backgroundColor: BRAND, borderColor: BRAND, color: BRAND_TEXT }
                      : { backgroundColor: 'transparent', borderColor: '#888', color: '#888' }
                    }
                  >
                    Division not listed
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Section header ── */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl md:text-2xl font-semibold flex items-center gap-2 dark:text-white">
            <BookOpen size={24} className="text-slate-700 dark:text-slate-300" />
            {hasActiveFilters ? 'Filtered publications' : 'Recent publications'}
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
                Clear filters
              </button>
            )}
            <span className="text-xs md:text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-200 dark:bg-slate-800 px-3 py-1 rounded-full border border-slate-300 dark:border-slate-700 hidden sm:inline-block">
              Live via Europe PMC
            </span>
          </div>
        </div>

        {/* ── Loading state ── */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-20 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700">
            <Loader2 size={48} className="animate-spin mb-4 text-slate-400" />
            <p className="text-slate-500 dark:text-slate-400 font-medium">
              {selectedDept ? `Fetching publications for ${selectedDept}…` : 'Fetching publications…'}
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
            <p className="text-slate-500 dark:text-slate-400 font-medium">No publications found.</p>
            <button onClick={clearFilters} className="mt-4 text-sm font-medium hover:underline text-slate-600 dark:text-slate-400">
              Clear filters
            </button>
          </div>
        )}

        {/* ── Publications grid ── */}
        {!isLoading && !error && displayPubs.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {displayPubs.map(pub => (
                <div key={pub.id}
                  className="bg-white dark:bg-slate-800 rounded-xl shadow-sm hover:shadow-md transition-all duration-200 border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden">
                  <div className="p-5 flex-grow">
                    <div className="flex justify-between items-start mb-2 gap-2">
                      <div className="text-xs font-bold uppercase tracking-wider line-clamp-1 text-slate-600 dark:text-slate-400"
                        title={pub.journal}>
                        {pub.journal}
                      </div>
                      <div className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0 bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded">
                        <Calendar size={12} />
                        {pub.date}
                      </div>
                    </div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mb-3 leading-snug">
                      {pub.title}
                    </h3>
                    <div className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-400 mb-3">
                      <Users size={15} className="shrink-0 mt-0.5" />
                      <p className="leading-snug">
                        {pub.authorNames.map((name, i) => (
                          <React.Fragment key={name + i}>
                            {i > 0 && <span>, </span>}
                            <button
                              onClick={() => setAuthorProfile(name)}
                              className="hover:underline transition-colors"
                              style={{ color: 'inherit' }}
                              onMouseOver={e => e.currentTarget.style.color = '#000'}
                              onMouseOut={e => e.currentTarget.style.color = ''}
                              title={`View profile of ${name}`}
                            >
                              {name}
                            </button>
                          </React.Fragment>
                        ))}
                        {pub.hasMoreAuthors && <span>, et al.</span>}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {pub.departments.map(d => (
                        <button key={d}
                          onClick={() => setSelectedDept(d)}
                          className="text-xs px-2 py-0.5 rounded-full border border-black text-slate-700 dark:border-slate-400 dark:text-slate-300 transition-colors hover:bg-yellow-100 dark:hover:bg-slate-700"
                          title={`Filter by ${d}`}>
                          {d}
                        </button>
                      ))}
                    </div>
                    <SdgBadges pub={pub} />
                  </div>
                  <div className="px-5 py-4 border-t border-slate-100 dark:border-slate-700 mt-auto flex gap-2">
                    <button
                      onClick={() => setSummaryPub(pub)}
                      className="inline-flex items-center justify-center gap-1.5 text-sm font-medium py-2.5 px-3 rounded-lg border border-slate-300 text-slate-600 transition-colors hover:border-black hover:text-black dark:border-slate-600 dark:text-slate-300"
                      title="Generate a public-friendly summary with AI"
                    >
                      <Sparkles size={14} />
                      Summary
                    </button>
                    <a href={pub.link} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center justify-center flex-1 gap-2 text-sm font-bold py-2.5 px-4 rounded-lg transition-colors"
                      style={{ backgroundColor: BRAND, color: BRAND_TEXT }}
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
                    ? <><Loader2 size={18} className="animate-spin" /> Loading articles…</>
                    : <>Load more articles <ChevronDown size={18} /></>
                  }
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 py-6 text-center text-xs text-slate-400 dark:text-slate-600">
        Publication data via{' '}
        <a href="https://europepmc.org" target="_blank" rel="noopener noreferrer"
          className="hover:underline text-slate-600 dark:text-slate-400">
          Europe PubMed Central
        </a>
        {' '}· Utrecht Institute for Pharmaceutical Sciences, Utrecht University
      </footer>
    </div>
  );
}
