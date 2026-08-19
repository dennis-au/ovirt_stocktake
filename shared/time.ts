const sqliteUtcTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function sqliteUtcTimestampToIso(value: string | undefined): string | undefined {
  if (!value || !sqliteUtcTimestamp.test(value)) {
    return undefined;
  }
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function formatHongKongDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";

  return `${part("day")}/${part("month")}/${part("year")}, ${part("hour")}:${part("minute")}:${part("second")} HKT`;
}
