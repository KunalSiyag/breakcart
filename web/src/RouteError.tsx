import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

/** Last-resort error boundary for render errors (API errors are handled in-page). */
export default function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error';
  return (
    <div className="route-error" role="alert">
      <div className="route-error-card">
        <div className="route-error-emoji" aria-hidden="true">
          💥
        </div>
        <h1>Something broke in the browser</h1>
        <p>
          This one isn’t a planted bug — the page crashed while rendering. Reloading usually fixes it.
        </p>
        <pre>{message}</pre>
        <div className="route-error-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload page
          </button>
          <Link to="/" className="btn btn-secondary">
            Storefront
          </Link>
          <Link to="/warroom" className="btn btn-secondary">
            War Room
          </Link>
        </div>
      </div>
    </div>
  );
}
