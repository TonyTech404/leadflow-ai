import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import './styles.css';
import { SessionProvider } from './session';
import { Shell } from './components/Shell';
import { OverviewPage } from './pages/OverviewPage';
import { PipelinePage } from './pages/PipelinePage';
import { LeadsPage } from './pages/LeadsPage';
import { LeadPage } from './pages/LeadPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AutomationsPage } from './pages/AutomationsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ApiDocsPage } from './pages/ApiDocsPage';
import { PublicFormPage } from './pages/PublicFormPage';

const router = createBrowserRouter([
  { path: '/f/:slug', element: <PublicFormPage /> },
  {
    element: <Shell />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/c/:clientId/pipeline', element: <PipelinePage /> },
      { path: '/c/:clientId/leads', element: <LeadsPage /> },
      { path: '/c/:clientId/analytics', element: <AnalyticsPage /> },
      { path: '/c/:clientId/automations', element: <AutomationsPage /> },
      { path: '/leads/:id', element: <LeadPage /> },
      { path: '/integrations', element: <IntegrationsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/developers', element: <ApiDocsPage /> },
      { path: '*', element: <p className="py-20 text-center text-ink-2">That page does not exist. <a href="/" className="underline">Go to the overview</a></p> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
