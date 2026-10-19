import type { ReadinessCheck, RunningConsumer } from "@payment-be/shared";

export function consumersCheck(
  consumers: Pick<RunningConsumer, "running">[]
): ReadinessCheck {
  return {
    check: () => consumers.every((consumer) => consumer.running()),
    name: "consumers",
  };
}
