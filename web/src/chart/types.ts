import type { Message } from '../i18n';

export interface Bucket {
  start: string;
  end: string;
  value: number | null;
  min: number | null;
  max: number | null;
  samples: number;
  held_from: string | null;
  expected_samples: number | null;
  known_sources: number | null;
  total_sources: number | null;
  partial: boolean;
  lower_bound: boolean;
  gap_reason: Message | null;
  so_far: boolean;
}
export interface ChartSeries {
  id: string;
  label?: string;
  slot?: number;
  buckets: Bucket[];
  summary: Message;
}
export interface ChartData {
  start: string;
  end: string;
  as_of: string;
  bucket_seconds: number;
  last_sample: string | null;
  series: ChartSeries[];
}
