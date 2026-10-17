import { Link, useParams, useSearchParams } from 'react-router';
import { shopApi } from '../../api/shop';
import { rememberProducts } from '../../lib/art';
import { formatInt, formatMs } from '../../lib/format';
import { useAsync, useDocumentTitle } from '../../lib/hooks';
import { ErrorNotice, Loading, Pagination, SkeletonGrid } from '../components/feedback';
import { ProductGrid, ProductTile } from '../components/product';

const PAGE_SIZE = 24;

export default function CategoryPage() {
  const { category = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  useDocumentTitle(`${category} — BreakCart`);

  const res = useAsync(
    async (signal) => {
      const r = await shopApi.products({ category, page, pageSize: PAGE_SIZE }, signal);
      const items = Array.isArray(r.data?.items) ? r.data.items : [];
      rememberProducts(items);
      return { ...r.data, items, rtt: r.ms };
    },
    [category, page],
  );

  const goTo = (p: number) => {
    setParams(p > 1 ? { page: String(p) } : {});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="container page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Home</Link> <span aria-hidden="true">›</span> <span>{category}</span>
      </nav>
      <div className="page-head">
        <h1>{category}</h1>
        {res.data && (
          <p className="muted">
            {formatInt(res.data.total)} products · page {res.data.page ?? page} · loaded in {formatMs(res.data.rtt)}
          </p>
        )}
      </div>
      {res.error && <ErrorNotice error={res.error} onRetry={res.reload} />}
      {res.loading && <Loading label={`Loading ${category}`} startedAt={res.startedAt} inline={Boolean(res.data)} />}
      {!res.data && res.loading && <SkeletonGrid count={12} />}
      {res.data && (
        <div className={res.loading ? 'is-refetching' : undefined}>
          {res.data.items.length === 0 ? (
            <p className="muted">Nothing in this category yet.</p>
          ) : (
            <ProductGrid dense>
              {res.data.items.map((p) => (
                <ProductTile key={p.id} p={p} />
              ))}
            </ProductGrid>
          )}
          <Pagination page={page} pageSize={res.data.pageSize || PAGE_SIZE} total={res.data.total ?? 0} onPage={goTo} />
        </div>
      )}
    </div>
  );
}
