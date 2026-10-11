import api from "@/lib/api-client";
import {
  IAttachmentSearch,
  IPageSearch,
  IPageSearchParams,
  IPageSearchResponse,
  ISuggestionResult,
  SearchSuggestionParams,
} from '@/features/search/types/search.types';

// #701: `items` are the real matches; `related` are vector-only semantic
// neighbours (first page only, not counted as matches).
export async function searchPage(
  params: IPageSearchParams,
): Promise<{ items: IPageSearch[]; related: IPageSearch[] }> {
  const req = await api.post<IPageSearchResponse>("/search", params);
  return { items: req.data.items, related: req.data.related ?? [] };
}

export async function searchSuggestions(
  params: SearchSuggestionParams,
): Promise<ISuggestionResult> {
  const req = await api.post<ISuggestionResult>("/search/suggest", params);
  return req.data;
}

export async function searchShare(
  params: IPageSearchParams,
): Promise<IPageSearch[]> {
  const req = await api.post<{ items: IPageSearch[] }>("/search/share-search", params);
  return req.data.items;
}

export async function searchAttachments(
  params: IPageSearchParams,
): Promise<IAttachmentSearch[]> {
  const req = await api.post<{ items: IAttachmentSearch[] }>("/search-attachments", params);
  return req.data.items;
}
