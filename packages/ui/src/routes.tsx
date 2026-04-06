import { createMemoryRouter, Navigate } from 'react-router-dom';
import App from './App';
import { Login } from '@/components/Login';
import { DebugPage } from '@/components/DebugPage';
import { Presets } from '@/components/Presets';
import { PoolDashboard } from '@/components/PoolDashboard';
import ProtectedRoute from '@/components/ProtectedRoute';
import PublicRoute from '@/components/PublicRoute';

export const router = createMemoryRouter([
  {
    path: '/',
    element: <Navigate to="/dashboard" replace />,
  },
  {
    path: '/login',
    element: <PublicRoute><Login /></PublicRoute>,
  },
  {
    path: '/dashboard',
    element: <ProtectedRoute><App /></ProtectedRoute>,
  },
  {
    path: '/presets',
    element: <ProtectedRoute><Presets /></ProtectedRoute>,
  },
  {
    path: '/debug',
    element: <ProtectedRoute><DebugPage /></ProtectedRoute>,
  },
  {
    path: '/pool',
    element: <ProtectedRoute><PoolDashboard /></ProtectedRoute>,
  },
], {
  initialEntries: ['/dashboard']
});