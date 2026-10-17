import { useDocumentTitle, useNow } from '../../lib/hooks';
import { ControlTabs } from '../components/ControlTabs';
import { IntegrityPanel } from '../components/IntegrityPanel';
import { KpiGrid } from '../components/KpiGrid';
import { QuickActions } from '../components/QuickActions';
import { ScenarioBar } from '../components/ScenarioBar';
import { BreakersPanel, ServiceGrid } from '../components/ServiceGrid';
import { FunnelTable, RouteTable } from '../components/Tables';
import { LatestIncident } from '../components/Timeline';
import { FunnelLatencyCard, GatewayTrafficCard, LatencyCard, LoadgenCard } from '../components/TrafficCharts';

/** Charts share one clock so every x-axis shows the same 10-minute window. */
function Charts() {
  const now = useNow(2000);
  return (
    <>
      <div className="chart-grid">
        <GatewayTrafficCard now={now} />
        <LatencyCard now={now} height={262} />
        <FunnelLatencyCard now={now} />
        <LoadgenCard now={now} />
      </div>
      <FunnelTable />
    </>
  );
}

export default function WarRoomPage() {
  useDocumentTitle('War Room — BreakCart');
  return (
    <div className="warroom">
      <h1 className="sr-only">BreakCart War Room</h1>
      <div className="wr-top">
        <ScenarioBar />
        <QuickActions />
        <LatestIncident />
      </div>
      <div className="wr-layout">
        <div className="wr-main">
          <KpiGrid />
          <IntegrityPanel />
          <Charts />
          <RouteTable />
          <ServiceGrid />
          <BreakersPanel />
        </div>
        <aside className="wr-side" aria-label="Control desk">
          <ControlTabs />
        </aside>
      </div>
    </div>
  );
}
