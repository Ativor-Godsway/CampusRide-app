import { ConfirmSubmit } from "../components/ConfirmSubmit";
import { Link } from "../lib/router";
import { useInvestorView } from "../lib/useInvestorView";
import { FarPricingCard } from "../screens/FarPricingCard";
import { PricesCard } from "../screens/PricesCard";
import { WaitFeeCard } from "../screens/WaitFeeCard";
import { Page, Section } from "../shell/Page";

/**
 * Pricing: what riders pay. Shared seat prices and Ride alone, the far-trip
 * surcharge and which places count as the far ends, and the pickup wait
 * fee. The same cards as Settings → Pricing; each saves on its own after a
 * confirm. New requests use new prices; requested rides keep theirs.
 */
export function PricingPage() {
  const investor = useInvestorView();
  return (
    <Page title="Pricing" subtitle="What riders pay. New requests use a change at once; rides already requested keep their price.">
      <fieldset className="read-only" disabled={investor.on}>
        <ConfirmSubmit what="the prices">
          <div className="settings-stack">
            <Section title="Seat prices and Ride alone">
              <PricesCard />
            </Section>
            <Section title="Far trips">
              <FarPricingCard />
            </Section>
            <Section title="Pickup wait fee">
              <WaitFeeCard />
            </Section>
          </div>
        </ConfirmSubmit>
      </fieldset>
      <p className="muted small">
        CampusRide&apos;s commission on each fare is set on <Link to="/money?tab=commission">Payouts &amp; commission</Link>.
      </p>
    </Page>
  );
}
