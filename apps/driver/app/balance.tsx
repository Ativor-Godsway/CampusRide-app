import { useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { MOMO_NETWORKS, lastCreditText, paystackQuoteText, type MomoNetwork } from "@rida/shared";
import {
  BackButton,
  Button,
  Input,
  ListRow,
  LoadingState,
  Notice,
  PhoneInput,
  Screen,
  SegmentedControl,
  Text,
  colors,
  formatCedis,
  radii,
  spacing,
  useAuth,
  type CommissionPayment,
  type DriverBalance,
} from "@rida/mobile-shared";
import { useCommissionPayment, useDriverBalance } from "../lib/balance";

const NETWORK_LABEL: Record<MomoNetwork, string> = { MTN: "MTN", TELECEL: "Telecel", AIRTELTIGO: "AirtelTigo" };

/** Under the amount: the limit, or how close to it the driver is. */
function limitLine(data: DriverBalance): string {
  const owed = data.balancePesewas;
  if (owed < 0) return `${formatCedis(-owed)} paid ahead: it counts against your next trips.`;
  if (!data.rules.enforcementEnabled) return "Commission-free launch: you can keep driving whatever you owe.";
  if (data.blocked) return `You're at the ${formatCedis(data.rules.debtLimitPesewas)} limit. Pay to go online again.`;
  return data.warning ?? `Limit ${formatCedis(data.rules.debtLimitPesewas)}. At the limit you can't go online until you pay.`;
}

/**
 * Balance: what the driver owes CampusRide (15% of each cash fare), the
 * limit, paying it, and one line for the latest payment or waiver. Paying is
 * the whole balance at once, by MoMo through Paystack: Paystack's fee is
 * added on top ("Owed X + payment fee Y = Pay Z") so CampusRide receives X.
 * The driver approves on their phone; the screen waits until the server
 * says Paystack confirmed it. The full history is on the admin site.
 */
export default function BalanceScreen() {
  const { data, isLoading, isError, refetch, isRefetching } = useDriverBalance();
  const pay = useCommissionPayment(data?.pendingPayment ?? null);

  const title = (
    <View style={styles.header}>
      <BackButton />
      <Text variant="title1" accessibilityRole="header">
        Balance
      </Text>
    </View>
  );

  if (isLoading) {
    return (
      <Screen>
        {title}
        <LoadingState />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen style={styles.content}>
        {title}
        <Notice tone="error" icon="cloud-offline-outline" message="Couldn't load your balance. Check your connection and try again." />
        <Button label="Try again" variant="secondary" onPress={() => void refetch()} loading={isRefetching} />
      </Screen>
    );
  }

  const owed = data.balancePesewas;
  const paid = pay.payment?.status === "SUCCESS" ? pay.payment : null;
  return (
    <Screen
      scroll
      style={styles.content}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.green500} colors={[colors.green500]} />}
    >
      {title}

      <View style={styles.hero}>
        {owed > 0 ? (
          <>
            <Text variant="eyebrow" color="secondary">
              You owe CampusRide
            </Text>
            <Text variant="display" tabular accessibilityLabel={`You owe ${formatCedis(owed)}`}>
              {formatCedis(owed)}
            </Text>
          </>
        ) : (
          <Text variant="title2" accessibilityRole="header">
            You&apos;re all paid up
          </Text>
        )}
        {owed !== 0 ? (
          <Text variant="subhead" color={data.blocked ? "danger" : "secondary"}>
            {limitLine(data)}
          </Text>
        ) : null}
        {data.lastCredit ? (
          <Text variant="caption" color="secondary">
            {lastCreditText(data.lastCredit)}
          </Text>
        ) : null}
      </View>

      {paid ? (
        <Text variant="bodyStrong" color="brand" accessibilityLiveRegion="polite">
          {`Paid ✓ ${formatCedis(paid.grossPesewas)}`}
        </Text>
      ) : null}

      {owed > 0 || pay.payment?.status === "PENDING" ? <PaySection data={data} pay={pay} /> : null}
    </Screen>
  );
}

function PaySection({ data, pay }: { data: DriverBalance; pay: ReturnType<typeof useCommissionPayment> }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [digits, setDigits] = useState(() => (user?.phone ?? "").replace(/\D/g, "").slice(-9));
  const [network, setNetwork] = useState<MomoNetwork>("MTN");
  const succeeded = pay.payment?.status === "SUCCESS";
  useEffect(() => {
    if (succeeded) setOpen(false);
  }, [succeeded]);

  // Waiting, or why it didn't go through (Try again comes back to the form).
  if (pay.payment && pay.payment.status !== "SUCCESS") {
    return <PaymentProgress payment={pay.payment} pay={pay} onTryAgain={() => setOpen(true)} />;
  }

  if (!data.canPay) {
    return <Notice icon="information-circle-outline" message="Paying in the app isn't available yet. Pay CampusRide in person for now." />;
  }
  if (!data.quote) {
    return (
      <Text variant="body" color="secondary">
        Under {formatCedis(data.minPaymentPesewas)} owed: you can pay it with your next trips&apos; commission.
      </Text>
    );
  }

  const quote = data.quote;
  return (
    <View style={styles.card}>
      <View>
        <ListRow title="Owed" trailing={<Text variant="bodyStrong" tabular>{formatCedis(quote.owedPesewas)}</Text>} showChevron={false} />
        <ListRow divider title="Payment fee" subtitle="Paystack's fee, so CampusRide receives what you owe" trailing={<Text variant="bodyStrong" tabular>{formatCedis(quote.feePesewas)}</Text>} showChevron={false} />
        <ListRow divider title="You pay" trailing={<Text variant="title3" tabular>{formatCedis(quote.grossPesewas)}</Text>} showChevron={false} accessibilityLabel={paystackQuoteText(quote)} />
      </View>

      {!open ? (
        <Button label="Pay now" icon="phone-portrait-outline" onPress={() => setOpen(true)} fullWidth />
      ) : (
        <View style={styles.form}>
          <PhoneInput label="MoMo number" digits={digits} onChangeDigits={setDigits} />
          <SegmentedControl
            options={MOMO_NETWORKS}
            value={network}
            onChange={setNetwork}
            accessibilityLabel="Mobile money network"
          />
          {pay.error ? <Notice tone="error" message={pay.error} /> : null}
          <Button
            label={`Pay ${formatCedis(quote.grossPesewas)}`}
            loading={pay.busy}
            disabled={digits.length !== 9}
            onPress={() => void pay.payMomo(`0${digits}`, network)}
            fullWidth
          />
          <Text variant="caption" color="secondary">
            You&apos;ll get a prompt on your phone to approve with your MoMo PIN. You pay the whole balance at once.
          </Text>
          <Button label="Pay on Paystack's page instead" variant="text" onPress={() => void pay.payOnPaystackPage()} disabled={pay.busy} />
        </View>
      )}
    </View>
  );
}

/**
 * "Waiting for payment…": what Paystack asks for (approve, a code, its page);
 * after two minutes "Didn't get the prompt?"; or why it didn't go through.
 */
function PaymentProgress({
  payment,
  pay,
  onTryAgain,
}: {
  payment: CommissionPayment;
  pay: ReturnType<typeof useCommissionPayment>;
  onTryAgain: () => void;
}) {
  const [code, setCode] = useState("");
  const pending = payment.status === "PENDING";
  const mismatch = payment.status === "MISMATCH";
  const slow = pending && pay.slow && !payment.needsOtp;
  const from = `${payment.momoNetwork ? ` from ${NETWORK_LABEL[payment.momoNetwork]}${payment.phoneLast4 ? ` •••${payment.phoneLast4}` : ""}` : ""}`;

  if (!pending && !mismatch) {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <Text variant="title3" accessibilityRole="header">
          Payment didn&apos;t go through
        </Text>
        <Text variant="body" color="secondary">
          {payment.message ?? "Nothing was taken from your account. Try again."}
        </Text>
        <Button
          label="Try again"
          onPress={() => {
            pay.dismiss();
            onTryAgain();
          }}
          fullWidth
        />
      </View>
    );
  }

  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <Text variant="title3" accessibilityRole="header">
        {mismatch
          ? "We're checking this payment"
          : slow
            ? payment.channel === "CHECKOUT"
              ? "Not confirmed yet"
              : "Didn't get the prompt?"
            : "Waiting for payment…"}
      </Text>
      <Text variant="body" color="secondary">
        {mismatch
          ? "CampusRide will check it and update your balance."
          : slow
            ? payment.channel === "CHECKOUT"
              ? "If you've paid, check again. Otherwise start over."
              : "If you approved it, check again. If no prompt came, start over to send a new one."
            : (payment.message ?? "Approve the payment on your phone.")}
      </Text>
      <Text variant="subhead" tabular>
        {`Paying ${formatCedis(payment.grossPesewas)}${from}`}
      </Text>

      {payment.needsOtp ? (
        <View style={styles.form}>
          <Input label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={12} doneAccessory />
          <Button label="Send code" loading={pay.busy} disabled={code.trim().length < 3} onPress={() => void pay.sendCode(code.trim())} fullWidth />
        </View>
      ) : null}
      {pending && payment.checkoutUrl ? <Button label="Open the Paystack page" variant="secondary" onPress={() => void pay.openPage()} fullWidth /> : null}
      {pay.error ? <Notice tone="error" message={pay.error} /> : null}
      {slow ? (
        <View style={styles.form}>
          <Button label="Check again" onPress={() => void pay.checkAgain()} loading={pay.checking} fullWidth />
          <Button
            label="Start over"
            variant="secondary"
            onPress={() => {
              pay.dismiss();
              onTryAgain();
            }}
            fullWidth
          />
        </View>
      ) : pending ? (
        <>
          <Text variant="caption" color="secondary">
            This updates by itself once Paystack confirms it. You can leave this screen.
          </Text>
          <Button label="Start over" variant="text" onPress={pay.dismiss} />
        </>
      ) : (
        <Button label="OK" variant="text" onPress={pay.dismiss} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing[2], marginTop: spacing[2] },
  content: { gap: spacing[5], paddingBottom: spacing[10] },
  hero: { gap: spacing[1] },
  card: { gap: spacing[3], padding: spacing[4], borderRadius: radii.lg, backgroundColor: colors.surface2 },
  form: { gap: spacing[3] },
});
