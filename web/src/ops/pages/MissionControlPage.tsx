import type { ReactNode } from 'react';
import { useDocumentTitle } from '../../lib/hooks';
import { useStickyTop } from '../../lib/viewport';
import '../../styles/mission.css';
import { IntegrityPanel } from '../components/IntegrityPanel';
import { JourneyFeed } from '../components/JourneyFeed';
import { FunnelCard, HotStockCard, MissionHeader, MissionKpis, RightNow } from '../components/MissionPanels';
import { ScenarioBar } from '../components/ScenarioBar';
import { StorePreview } from '../components/StorePreview';
import { SystemMap } from '../components/SystemMap';
import { Timeline } from '../components/Timeline';

/** Where the map column pins (sticky from 1200px): under the 52px top bar. Keep in sync with mission.css. */
const PIN_TOP = 64;
const PIN_GAP = 12;

/**
 * Mission Control (/live): the storefront and the backend on one screen. Left, the real
 * store in a frame plus sampled shopper journeys; right, the live system map; below, the
 * funnel, hot-deal stock, business invariants and incidents. Reads the same ops store as
 * the war room; the only controls are the war room's own scenario bar.
 */
export default function MissionControlPage() {
  useDocumentTitle('Mission Control — BreakCart');
  return (
    <div className="mc">
      <MissionHeader />
      <ScenarioBar />
      <RightNow />
      <MissionKpis />
      <div className="mc-cols">
        <div className="mc-col mc-col-store">
          <StorePreview />
          <JourneyFeed />
        </div>
        <SystemColumn>
          <SystemMap />
        </SystemColumn>
      </div>
      <div className="mc-bottom">
        <FunnelCard />
        <HotStockCard />
        <IntegrityPanel compact />
        <Timeline limit={8} compact />
      </div>
    </div>
  );
}

/**
 * The map column. Taller than the window, it pins only once its bottom is in view. A component
 * of its own, so a new offset re-renders this wrapper, not the page.
 */
function SystemColumn({ children }: { children: ReactNode }) {
  const [ref, top] = useStickyTop<HTMLDivElement>(PIN_TOP, PIN_GAP);
  return (
    <div ref={ref} className="mc-col mc-col-system" style={{ top }}>
      {children}
    </div>
  );
}
