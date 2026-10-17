import { useDocumentTitle } from '../../lib/hooks';
import { EmptyState } from '../components/feedback';

export default function NotFoundPage() {
  useDocumentTitle('Page not found — BreakCart');
  return (
    <div className="container page">
      <EmptyState emoji="🧭" title="This page wandered off" action={{ to: '/', label: 'Back to the deals' }}>
        The link may be broken, or the page may have been removed.
      </EmptyState>
    </div>
  );
}
