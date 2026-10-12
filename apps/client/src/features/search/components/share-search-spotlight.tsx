import { Group, Center, Text } from "@mantine/core";
import { Spotlight } from "@mantine/spotlight";
import { IconSearch } from "@tabler/icons-react";
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useDebouncedValue } from "@mantine/hooks";
import { useShareSearchQuery } from "@/features/search/queries/search-query";
import { buildSharedPageUrl } from "@/features/page/page.utils.ts";
import { getPageIcon } from "@/lib";
import { useTranslation } from "react-i18next";
import { shareSearchSpotlightStore } from "@/features/search/constants.ts";
import { IPageSearch } from "@/features/search/types/search.types";
import DOMPurify from "dompurify";

interface ShareSearchSpotlightProps {
  shareId?: string;
}
export function ShareSearchSpotlight({ shareId }: ShareSearchSpotlightProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [debouncedSearchQuery] = useDebouncedValue(query, 300);

  const { data: searchResults } = useShareSearchQuery({
    query: debouncedSearchQuery,
    shareId,
  });

  const toAction = (page: IPageSearch) => (
    <Spotlight.Action
      key={page.id}
      component={Link}
      //@ts-ignore
      to={buildSharedPageUrl({
        shareId: shareId,
        pageTitle: page.title,
        pageSlugId: page.slugId,
      })}
      style={{ userSelect: "none" }}
    >
      <Group wrap="nowrap" w="100%">
        <Center>{getPageIcon(page?.icon)}</Center>

        <div style={{ flex: 1 }}>
          <Text>{page.title}</Text>

          {page?.highlight && (
            <Text
              opacity={0.6}
              size="xs"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(page.highlight, {
                  ALLOWED_TAGS: ["mark", "em", "strong", "b"],
                  ALLOWED_ATTR: []
                }),
              }}
            />
          )}
        </div>
      </Group>
    </Spotlight.Action>
  );

  const pages = (searchResults?.items ?? []).map(toAction);
  // #701: semantically similar pages that do NOT match the query — shown apart
  // from the matches, as in the in-app search.
  const relatedPages = (searchResults?.related ?? []).map(toAction);
  // A share whose search is disabled answers with the reason instead.
  const disabledReason = searchResults?.disabledReason;

  return (
    <>
      <Spotlight.Root
        store={shareSearchSpotlightStore}
        query={query}
        onQueryChange={setQuery}
        scrollable
        overlayProps={{
          backgroundOpacity: 0.55,
        }}
      >
        <Spotlight.Search
          placeholder={t("Search...")}
          aria-label={t("Search")}
          leftSection={<IconSearch size={20} stroke={1.5} />}
        />
        <Spotlight.ActionsList>
          {disabledReason ? (
            <Spotlight.Empty>
              {t(
                "Search is unavailable on this share because it publishes only saved versions.",
              )}
            </Spotlight.Empty>
          ) : (
            <>
              {query.length === 0 && pages.length === 0 && (
                <Spotlight.Empty>
                  {t("Start typing to search...")}
                </Spotlight.Empty>
              )}

              {query.length > 0 && pages.length === 0 && (
                <Spotlight.Empty>{t("No results found...")}</Spotlight.Empty>
              )}

              {pages.length > 0 && pages}

              {relatedPages.length > 0 && (
                <>
                  <Text size="xs" c="dimmed" px="sm" pt="sm" pb={4}>
                    {t("Similar pages")}
                  </Text>
                  {relatedPages}
                </>
              )}
            </>
          )}
        </Spotlight.ActionsList>
      </Spotlight.Root>
    </>
  );
}
