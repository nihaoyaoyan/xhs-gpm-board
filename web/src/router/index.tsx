import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import MainLayout from '@/layouts/MainLayout';
import { useAuthStore } from '@/stores/auth';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Trends from '@/pages/Trends';
import AdSearchTerms from '@/pages/AdSearchTerms';
import ShopSearchTerms from '@/pages/ShopSearchTerms';
import NoteSearchTerms from '@/pages/NoteSearchTerms';
import Ads from '@/pages/Ads';
import Comments from '@/pages/Comments';
import Shops from '@/pages/Shops';

// eslint-disable-next-line react-refresh/only-export-components
function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((state) => state.token);
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <MainLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'trends', element: <Trends /> },
      { path: 'ad-search-terms', element: <AdSearchTerms /> },
      { path: 'shop-search-terms', element: <ShopSearchTerms /> },
      { path: 'note-search-terms', element: <NoteSearchTerms /> },
      { path: 'ads', element: <Ads /> },
      { path: 'comments', element: <Comments /> },
      { path: 'shops', element: <Shops /> },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
];

export const router = createBrowserRouter(routes, {
  future: {
    v7_relativeSplatPath: true,
    v7_fetcherPersist: true,
    v7_normalizeFormMethod: true,
    v7_partialHydration: true,
    v7_skipActionErrorRevalidation: true,
  },
});
