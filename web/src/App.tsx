import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, redirect, RouterProvider } from 'react-router';
import RouteError from './RouteError';
import ShopLayout from './shop/ShopLayout';
import CartPage from './shop/pages/CartPage';
import CategoryPage from './shop/pages/CategoryPage';
import CheckoutPage from './shop/pages/CheckoutPage';
import HomePage from './shop/pages/HomePage';
import NotFoundPage from './shop/pages/NotFoundPage';
import OrderDetailPage from './shop/pages/OrderDetailPage';
import OrdersPage from './shop/pages/OrdersPage';
import ProductPage from './shop/pages/ProductPage';
import SearchPage from './shop/pages/SearchPage';

// The ops console (war room, mission control, labs) is heavy (recharts, the system map); keep it out of the
// storefront bundle.
const OpsLayout = lazy(() => import('./ops/OpsLayout'));
const WarRoomPage = lazy(() => import('./ops/pages/WarRoomPage'));
const MissionControlPage = lazy(() => import('./ops/pages/MissionControlPage'));
const LabsPage = lazy(() => import('./ops/pages/LabsPage'));
const LabDetailPage = lazy(() => import('./ops/pages/LabDetailPage'));

function OpsFallback() {
  return (
    <div className="ops-boot" role="status">
      <span className="spinner" aria-hidden="true" /> Loading the war room…
    </div>
  );
}

const ops = (node: ReactNode) => <Suspense fallback={<OpsFallback />}>{node}</Suspense>;

const router = createBrowserRouter([
  {
    element: <ShopLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'c/:category', element: <CategoryPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'p/:id', element: <ProductPage /> },
      { path: 'cart', element: <CartPage /> },
      { path: 'checkout', element: <CheckoutPage /> },
      { path: 'orders', element: <OrdersPage /> },
      { path: 'orders/:id', element: <OrderDetailPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  {
    element: ops(<OpsLayout />),
    errorElement: <RouteError />,
    children: [
      { path: 'warroom', element: ops(<WarRoomPage />) },
      { path: 'live', element: ops(<MissionControlPage />) },
      { path: 'labs', element: ops(<LabsPage />) },
      { path: 'labs/:id', element: ops(<LabDetailPage />) },
    ],
  },
  { path: 'mission-control', loader: () => redirect('/live') },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
