import { useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { MOMO_NETWORKS, clockTime, groupByDay, paystackQuoteText, type MomoNetwork } from "@rida/shared";
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
  type DriverBalanceEntry,
} from "@rida/mobile-shared";
import { useCommissionPayment, useDriverBalance } from "../lib/balance";

const NETWORK_LABEL: Record<MomoNetwork, string> = { MTN: "MTN", TELECEL: "Telecel", AIRTELTIGO: "AirtelTigo" };

/** "Trip commission", "Paid with MoMo", "Paid in person", "Waived by CampusRide". */
function entryTitle(e: DriverBalanceEntry): string {
  const base =
    e.kind === "COMMISSION"
      ? "Trip commission"
      : e.kind === "WAIVER"
        ? "Waived by CampusRide"
        : e.kind === "ADJUSTMENT"
          ? "Correction"
          : e.method === "PAYSTACK"
            ? "Paid with MoMo"
            : "Paid in person";
  return e.isReversal ? `${base} (cancelled)` : base;
}

function entrySubtitle(e: DriverBalanceEntry): string {
  const time = clockTime(e.at);
  if (e.kind === "COMMISSION") return e.route ? `${time} · ${e.route}` : time;
  if (e.method === "PAYSTACK" && e.momoNetwork) {
    const network = NETWORK_LABEL[e.momoNetwork as MomoNetwork] ?? e.momoNetwork;
    return `${time} · ${network}${e.phoneLast4 ? ` •••${e.phoneLast4}` : ""}`;
  }
  return time;
}

/** "+GH₵1.50" for what adds to the balance, "−GH₵85" for what takes it off. */
function signed(pesewas: number): string {
  return pesewas > 0 ? `+${formatCedis(pesewas)}` : formatCedis(pesewas);
}

/**
 * Balance: what the driver owes CampusRide (15% of each cash fare), the
 * limit, the history, and paying it. Paying is the whole balance at once,
 * by MoMo through Paystack: Paystack's fee is added on top ("Owed X +
 * payment fee Y = Pay Z") so CampusRide receives X. The driver approves on
 * their phone; the screen waits until the server says Paystack confirmed it.
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
  return (
    <Screen
      scroll
      style={styles.content}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.green500} colors={[colors.green500]} />}
    >
      {title}

      <View style={styles.hero}>
        <Text variant="eyebrow" color="secondary">
          {owed > 0 ? "You owe CampusRide" : "Your balance"}
        </Text>
        <Text variant="display" tabular accessibilityLabel={owed > 0 ? `You owe ${formatCedis(owed)}` : "Nothing owed"}>
          {formatCedis(Math.max(0, owed))}
        </Text>
        <Text variant="subhead" color="secondary">
          {owed < 0
            ? `${formatCedis(-owed)} paid ahead: it counts against your next trips.`
            : data.rules.enforcementEnabled
              ? `Limit ${formatCedis(data.rules.debtLimitPesewas)}. At the limit you can't go online until you pay.`
              : "Commission-free launch: you can keep driving whatever you owe."}
        </Text>
      </View>

      {data.blocked ? (
        <Notice tone="error" icon="alert-circle-outline" message={`You owe ${formatCedis(owed)}. Pay it to go online again.`} />
      ) : data.warning ? (
        <Notice icon="alert-circle-outline" message={data.warning} />
      ) : null}

      {owed > 0 ? <PaySection data={data} pay={pay} /> : null}

      <View style={styles.section}>
        <Text variant="title3" accessibilityRole="header">
          History
        </Text>
        <Text variant="caption" color="secondary">
          Riders pay you the whole fare in cash; CampusRide&apos;s 15% of each trip adds to what you owe.
        </Text>
        {data.history.length === 0 ? (
          <Text variant="body" color="secondary">
            Nothing yet. Each trip&apos;s commission shows up here.
          </Text>
        ) : (
          groupByDay(data.history, (e) => e.at).map((day) => (
            <View key={day.label} style={styles.day}>
              <Text variant="bodyStrong" color="secondary" accessibilityRole="header">
                {day.label}
              </Text>
              <View>
                {day.items.map((e, i) => (
                  <ListRow
                    key={e.id}
                    divider={i > 0}
                    title={entryTitle(e)}
                    subtitle={entrySubtitle(e)}
                    trailing={
                      <Text variant="bodyStrong" tabular color={e.effectPesewas < 0 ? "brand" : undefined}>
                        {signed(e.effectPesewas)}
                      </Text>
                    }
                    showChevron={false}
                    accessibilityLabel={`${entryTitle(e)}, ${entrySubtitle(e)}, ${signed(e.effectPesewas)}`}
                  />
                ))}
              </View>
            </View>
          ))
        )}
      </View>
    </Screen>
  );
}

function PaySection({ data, pay }: { data: DriverBalance; pay: ReturnType<typeof useCommissionPayment> }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [digits, setDigits] = useState(() => (user?.phone ?? "").replace(/\D/g, "").slice(-9));
  const [network, setNetwork] = useState<MomoNetwork>("MTN");

  if (pay.payment && pay.payment.status !== "SUCCESS" && (pay.payment.status === "PENDING" || open)) {
    return <PaymentProgress payment={pay.payment} pay={pay} />;
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
      {pay.payment?.status === "SUCCESS" ? (
        <Text variant="bodyStrong" color="brand" accessibilityLiveRegion="polite">
          Paid {formatCedis(pay.payment.owedPesewas)}. Thank you!
        </Text>
      ) : null}
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

/** "Waiting for payment…": what Paystack asks for (approve, a code, its page), or why it failed. */
function PaymentProgress({ payment, pay }: { payment: CommissionPayment; pay: ReturnType<typeof useCommissionPayment> }) {
  const [code, setCode] = useState("");
  const pending = payment.status === "PENDING";
  const failed = payment.status === "FAILED" || payment.status === "ABANDONED";
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <Text variant="title3" accessibilityRole="header">
        {pending ? "Waiting for payment…" : payment.status === "MISMATCH" ? "We're checking this payment" : "Payment didn't go through"}
      </Text>
      <Text variant="body" color="secondary">
        {payment.message ??
          (pending ? "Approve the payment on your phone." : payment.status === "MISMATCH" ? "CampusRide will check it and update your balance." : "Try again.")}
      </Text>
      <Text variant="subhead" tabular>
        {`Paying ${formatCedis(payment.grossPesewas)}${payment.momoNetwork ? ` from ${NETWORK_LABEL[payment.momoNetwork]}${payment.phoneLast4 ? ` •••${payment.phoneLast4}` : ""}` : ""}`}
      </Text>

      {payment.needsOtp ? (
        <View style={styles.form}>
          <Input label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={12} doneAccessory />
          <Button label="Send code" loading={pay.busy} disabled={code.trim().length < 3} onPress={() => void pay.sendCode(code.trim())} fullWidth />
        </View>
      ) : null}
      {pending && payment.checkoutUrl ? <Button label="Open the Paystack page" variant="secondary" onPress={() => void pay.openPage()} fullWidth /> : null}
      {pay.error ? <Notice tone="error" message={pay.error} /> : null}
      {pending ? (
        <Text variant="caption" color="secondary">
          This updates by itself once Paystack confirms it. You can leave this screen.
        </Text>
      ) : null}
      <Button label={failed ? "Try again" : pending ? "Start over" : "OK"} variant={failed ? "primary" : "text"} onPress={pay.dismiss} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing[2], marginTop: spacing[2] },
  content: { gap: spacing[5], paddingBottom: spacing[10] },
  hero: { gap: spacing[1] },
  section: { gap: spacing[3] },
  day: { gap: spacing[1] },
  card: { gap: spacing[3], padding: spacing[4], borderRadius: radii.lg, backgroundColor: colors.surface2 },
  form: { gap: spacing[3] },
});
