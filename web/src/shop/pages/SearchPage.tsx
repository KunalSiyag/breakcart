import { Link, useSearchParams } from 'react-router';
import { shopApi } from '../../api/shop';
import { rememberProducts } from '../../lib/art';
import { formatInt, formatMs } from '../../lib/format';
import { useAsync, useDocumentTitle } from '../../lib/hooks';
import { EmptyState, ErrorNotice, Loading, SkeletonGrid } from '../components/feedback';
import { ProductGrid, ProductTile } from '../components/product';

export default function SearchPage() {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  useDocumentTitle(q ? `“${q}” — BreakCart search` : 'Search — BreakCart');

  const res = useAsync(
    async (signal) => {
      if (!q) return null;
      const r = await shopApi.search(q, signal);
      const items = Array.isArray(r.data?.items) ? r.data.items : [];
      rememberProducts(items);
      return { items, tookMs: r.data?.tookMs ?? null, rtt: r.ms };
    },
    [q],
  );

  if (!q) {
    return (
      <div className="container page">
        <EmptyState emoji="🔎" title="Search BreakCart">
          Type something in the search box above — try “phone”, “shoes” or “headphones”.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="container page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Home</Link> <span aria-hidden="true">›</span> <span>Search</span>
      </nav>
      <div className="page-head">
        <h1>
          Results for <q>{q}</q>
        </h1>
        {res.data && (
          <p className="muted">
            {formatInt(res.data.items.length)} results · search took {formatMs(res.data.tookMs)} on the server ·{' '}
            {formatMs(res.data.rtt)} in your browser
          </p>
        )}
      </div>
      {res.error && <ErrorNotice error={res.error} onRetry={res.reload} />}
      {res.loading && <Loading label="Searching" startedAt={res.startedAt} inline={Boolean(res.data)} />}
      {!res.data && res.loading && <SkeletonGrid count={8} />}
      {res.data &&
        (res.data.items.length === 0 ? (
          <EmptyState emoji="🤷" title="No matches" action={{ to: '/', label: 'Browse deals' }}>
            We couldn’t find anything for “{q}”. Try a shorter or different word.
          </EmptyState>
        ) : (
          <div className={res.loading ? 'is-refetching' : undefined}>
            <ProductGrid dense>
              {res.data.items.map((p) => (
                <ProductTile key={p.id} p={p} />
              ))}
            </ProductGrid>
          </div>
        ))}
    </div>
  );
}
