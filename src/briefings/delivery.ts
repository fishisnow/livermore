export interface DeliveryConfig {
  apiUrl: string;
  apiKey: string | undefined;
  publisher: string;
}

export async function deliverBriefing(config: DeliveryConfig, content: string, publishedAt: string): Promise<void> {
  const response = await fetch(`${config.apiUrl.replace(/\/$/, "")}/api/briefings/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ publisher: config.publisher, content, published_at: publishedAt }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Briefing delivery failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as { success?: boolean };
  if (payload.success !== true) {
    throw new Error("Briefing delivery endpoint did not confirm success.");
  }
}
