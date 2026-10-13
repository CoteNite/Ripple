import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { Article, ArticleCounts, ArticleListItem, Feed, rssApi, Tag } from '../api/client'
import { persistentStorage } from '../utils/persistentStorage'

const PINNED_ARTICLES_KEY = 'rssreader.pinnedArticleIds'
const SUMMARY_LINES_KEY = 'rssreader.summaryLineCount'
const SHOW_THUMBNAILS_KEY = 'rssreader.showThumbnails'
const LEFT_SIDEBAR_VISIBLE_KEY = 'rssreader.leftSidebarVisible'
const ARTICLE_LIST_VISIBLE_KEY = 'rssreader.articleListVisible'
const FILTER_PANEL_EXPANDED_KEY = 'rssreader.filterPanelExpanded'
const FEED_PANEL_EXPANDED_KEY = 'rssreader.feedPanelExpanded'
const TAG_PANEL_EXPANDED_KEY = 'rssreader.tagPanelExpanded'
const ARTICLE_SORT_ORDER_KEY = 'rssreader.articleSortOrder'

export const ARTICLE_PAGE_SIZE = 50

type SortOrder = 'newest' | 'oldest'

export interface ArticleListQuery {
  feed_id?: number
  tag_id?: number
  unread?: boolean
  starred?: boolean
  sort_order?: SortOrder
}

function storedJsonArray(key: string): number[] {
  const raw = persistentStorage.getItem(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item) => Number.isInteger(item)) : []
  } catch {
    return []
  }
}

function storedBoolean(key: string, fallback: boolean) {
  const raw = persistentStorage.getItem(key)
  if (raw === null) return fallback
  return raw === 'true'
}

function storedSummaryLines() {
  const raw = persistentStorage.getItem(SUMMARY_LINES_KEY)
  const value = raw ? Number(raw) : 3
  return Number.isFinite(value) && value >= 1 && value <= 5 ? Math.round(value) : 3
}

function storedSortOrder(): SortOrder {
  return persistentStorage.getItem(ARTICLE_SORT_ORDER_KEY) === 'oldest' ? 'oldest' : 'newest'
}

function emptyCounts(): ArticleCounts {
  return { total: 0, unread: 0, starred: 0, by_feed: {}, by_tag: {} }
}

function toListItem(article: Article): ArticleListItem {
  return {
    id: article.id,
    feed_id: article.feed_id,
    feed_title: article.feed_title,
    title: article.title,
    url: article.url,
    author: article.author,
    published_at: article.published_at,
    summary: article.summary,
    is_read: article.is_read,
    is_starred: article.is_starred,
    tag_ids: article.tag_ids,
    created_at: article.created_at
  }
}

function toArticle(item: ArticleListItem): Article {
  return {
    ...item,
    raw_html: '',
    cleaned_html: item.summary || '',
    cleaned_markdown: '',
    tag_ids: item.tag_ids
  }
}

function sortArticles(articles: ArticleListItem[], pinnedArticleIds: number[], sortOrder: SortOrder) {
  const pinned = new Set(pinnedArticleIds)
  return [...articles].sort((left, right) => {
    const leftPinned = pinned.has(left.id)
    const rightPinned = pinned.has(right.id)
    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1
    }

    const leftTime = Date.parse(left.published_at ?? left.created_at ?? '') || 0
    const rightTime = Date.parse(right.published_at ?? right.created_at ?? '') || 0
    return sortOrder === 'oldest' ? leftTime - rightTime : rightTime - leftTime
  })
}

function normalizeTagIds(tagIds: number[]) {
  return Array.from(new Set(tagIds.filter((tagId) => Number.isFinite(tagId)))).sort((left, right) => left - right)
}

export const useReaderStore = defineStore('reader', {
  state: () => ({
    feeds: [] as Feed[],
    articleItems: [] as ArticleListItem[],
    tags: [] as Tag[],
    selectedArticle: null as Article | null,
    articleCounts: emptyCounts(),
    feedArticleCache: {} as Record<number, ArticleListItem[]>,
    pagination: {
      limit: ARTICLE_PAGE_SIZE,
      offset: 0,
      total: 0,
      hasMore: false
    },
    detailCache: {} as Record<number, Article>,
    loading: false,
    loadingMore: false,
    loadRequestId: 0,
    countsRequestId: 0,
    protectedFeedCounts: {} as Record<number, number>,
    articleMutationVersion: 0,
    pinnedArticleIds: storedJsonArray(PINNED_ARTICLES_KEY),
    summaryLineCount: storedSummaryLines(),
    showThumbnails: storedBoolean(SHOW_THUMBNAILS_KEY, false),
    leftSidebarVisible: storedBoolean(LEFT_SIDEBAR_VISIBLE_KEY, true),
    articleListVisible: storedBoolean(ARTICLE_LIST_VISIBLE_KEY, true),
    filterPanelExpanded: storedBoolean(FILTER_PANEL_EXPANDED_KEY, true),
    feedPanelExpanded: storedBoolean(FEED_PANEL_EXPANDED_KEY, true),
    tagPanelExpanded: storedBoolean(TAG_PANEL_EXPANDED_KEY, false),
    articleSortOrder: storedSortOrder()
  }),
  getters: {
    articles: (state) => state.articleItems
  },
  actions: {
    async loadAll(query: ArticleListQuery = {}) {
      if (query.feed_id !== undefined && this.loadCachedFeedArticles(query.feed_id)) return
      if (query.tag_id !== undefined && query.tag_id < 0 && this.loadCachedTagArticles(query.tag_id)) return

      const requestId = this.loadRequestId + 1
      const countsRequestId = this.countsRequestId + 1
      this.loadRequestId = requestId
      this.countsRequestId = countsRequestId
      this.loading = true
      try {
        const normalizedQuery = this.withSort(query)
        const [feeds, articles, tags, counts] = await Promise.allSettled([
          rssApi.feeds(),
          rssApi.articles({ ...normalizedQuery, limit: ARTICLE_PAGE_SIZE, offset: 0 }),
          rssApi.tags(),
          rssApi.articleCounts()
        ])

        if (requestId !== this.loadRequestId) return

        if (feeds.status === 'fulfilled') {
          this.feeds = feeds.value
        } else {
          ElMessage.error('读取订阅失败，原内容已保留')
        }

        if (tags.status === 'fulfilled') {
          this.tags = tags.value
        } else {
          ElMessage.error('读取标签失败，原内容已保留')
        }

        if (counts.status === 'fulfilled' && countsRequestId === this.countsRequestId) {
          this.applyArticleCounts(counts.value)
        } else if (counts.status === 'rejected') {
          ElMessage.error('读取文章统计失败，原内容已保留')
        }

        if (articles.status === 'fulfilled') {
          this.articleItems = sortArticles(articles.value.items, this.pinnedArticleIds, this.articleSortOrder)
          this.pagination = {
            limit: articles.value.limit,
            offset: articles.value.offset + articles.value.items.length,
            total: articles.value.total,
            hasMore: articles.value.has_more
          }
          this.articleMutationVersion += 1
        } else {
          ElMessage.error('读取文章失败，原内容已保留，请检查 Ripple 数据目录')
        }

        await this.ensureSelectedArticle()
      } finally {
        if (requestId === this.loadRequestId) this.loading = false
      }
    },
    async loadMore(query: ArticleListQuery = {}) {
      if (this.loading || this.loadingMore || !this.pagination.hasMore) return
      this.loadingMore = true
      try {
        const page = await rssApi.articles({
          ...this.withSort(query),
          limit: this.pagination.limit,
          offset: this.pagination.offset
        })
        const existingIds = new Set(this.articleItems.map((article) => article.id))
        const nextItems = page.items.filter((article) => !existingIds.has(article.id))
        this.articleItems = sortArticles([...this.articleItems, ...nextItems], this.pinnedArticleIds, this.articleSortOrder)
        this.pagination = {
          limit: page.limit,
          offset: page.offset + page.items.length,
          total: page.total,
          hasMore: page.has_more
        }
        this.articleMutationVersion += 1
      } finally {
        this.loadingMore = false
      }
    },
    async loadCounts() {
      const requestId = this.countsRequestId + 1
      this.countsRequestId = requestId
      const counts = await rssApi.articleCounts()
      if (requestId === this.countsRequestId) {
        this.applyArticleCounts(counts)
      }
    },
    loadCachedFeedArticles(feedId: number) {
      const cachedArticles = this.feedArticleCache[feedId]
      if (!cachedArticles?.length) return false

      this.loadRequestId += 1
      this.loading = false
      this.articleItems = sortArticles(cachedArticles, this.pinnedArticleIds, this.articleSortOrder)
      this.pagination = {
        limit: ARTICLE_PAGE_SIZE,
        offset: this.articleItems.length,
        total: cachedArticles.length,
        hasMore: false
      }
      this.setFeedArticleCount(feedId, cachedArticles.length)
      this.articleMutationVersion += 1
      void this.ensureSelectedArticle()
      return true
    },
    loadCachedTagArticles(tagId: number) {
      const cachedArticles = this.knownArticleItems().filter((article) => article.tag_ids.includes(tagId))
      if (!cachedArticles.length && (this.articleCounts.by_tag[tagId] ?? 0) === 0) return false

      this.loadRequestId += 1
      this.loading = false
      this.articleItems = sortArticles(cachedArticles, this.pinnedArticleIds, this.articleSortOrder)
      this.pagination = {
        limit: ARTICLE_PAGE_SIZE,
        offset: this.articleItems.length,
        total: cachedArticles.length,
        hasMore: false
      }
      this.articleCounts = {
        ...this.articleCounts,
        by_tag: {
          ...this.articleCounts.by_tag,
          [tagId]: cachedArticles.length
        }
      }
      this.articleMutationVersion += 1
      void this.ensureSelectedArticle()
      return true
    },
    cacheFeedArticles(feedId: number, articles: Article[]) {
      const articleItems = articles.map(toListItem)
      this.feedArticleCache = {
        ...this.feedArticleCache,
        [feedId]: sortArticles(articleItems, this.pinnedArticleIds, this.articleSortOrder)
      }
      this.detailCache = {
        ...this.detailCache,
        ...Object.fromEntries(articles.map((article) => [article.id, article]))
      }
      this.setFeedArticleCount(feedId, articles.length)
      this.adjustCachedArticleCounts(articleItems)
    },
    applyArticleCounts(counts: ArticleCounts) {
      const nextCounts: ArticleCounts = {
        ...counts,
        by_feed: { ...counts.by_feed },
        by_tag: { ...counts.by_tag }
      }
      const remainingProtectedCounts: Record<number, number> = {}
      Object.entries(this.protectedFeedCounts).forEach(([key, protectedCount]) => {
        const feedId = Number(key)
        const backendCount = nextCounts.by_feed[feedId] ?? 0
        if (backendCount < protectedCount) {
          nextCounts.by_feed[feedId] = protectedCount
          nextCounts.total += protectedCount - backendCount
          remainingProtectedCounts[feedId] = protectedCount
        }
      })
      this.articleCounts = nextCounts
      this.protectedFeedCounts = remainingProtectedCounts
    },
    setFeedArticleCount(feedId: number, count: number, options: { protect?: boolean } = {}) {
      const previous = this.articleCounts.by_feed[feedId] ?? 0
      this.articleCounts = {
        ...this.articleCounts,
        total: Math.max(0, this.articleCounts.total - previous + count),
        by_feed: {
          ...this.articleCounts.by_feed,
          [feedId]: count
        }
      }
      if (options.protect !== false) {
        this.protectedFeedCounts = {
          ...this.protectedFeedCounts,
          [feedId]: Math.max(this.protectedFeedCounts[feedId] ?? 0, count)
        }
      }
    },
    adjustCachedArticleCounts(articles: ArticleListItem[]) {
      if (!articles.length) return
      const unreadIds = new Set<number>()
      const starredIds = new Set<number>()
      Object.values(this.feedArticleCache).forEach((items) => {
        items.forEach((article) => {
          if (!article.is_read) unreadIds.add(article.id)
          if (article.is_starred) starredIds.add(article.id)
        })
      })
      articles.forEach((article) => {
        if (!article.is_read) unreadIds.add(article.id)
        else unreadIds.delete(article.id)
        if (article.is_starred) starredIds.add(article.id)
        else starredIds.delete(article.id)
      })
      this.articleCounts = {
        ...this.articleCounts,
        unread: Math.max(this.articleCounts.unread, unreadIds.size),
        starred: Math.max(this.articleCounts.starred, starredIds.size)
      }
    },
    isCachedArticle(articleId: number) {
      return Object.values(this.feedArticleCache).some((articles) => articles.some((article) => article.id === articleId))
    },
    replaceCachedArticleItem(article: ArticleListItem) {
      const nextCache: Record<number, ArticleListItem[]> = {}
      Object.entries(this.feedArticleCache).forEach(([feedId, articles]) => {
        nextCache[Number(feedId)] = articles.map((item) => (item.id === article.id ? article : item))
      })
      this.feedArticleCache = nextCache
      const cachedDetail = this.detailCache[article.id]
      if (cachedDetail) {
        this.detailCache = { ...this.detailCache, [article.id]: { ...cachedDetail, ...article } }
      }
    },
    knownArticleItems() {
      const articleMap = new Map<number, ArticleListItem>()
      Object.values(this.feedArticleCache).forEach((items) => {
        items.forEach((article) => articleMap.set(article.id, article))
      })
      this.articleItems.forEach((article) => articleMap.set(article.id, article))
      Object.values(this.detailCache).forEach((article) => articleMap.set(article.id, toListItem(article)))
      return Array.from(articleMap.values())
    },
    articleTagIds(articleId: number) {
      const detail = this.detailCache[articleId]
      if (detail) return detail.tag_ids
      if (this.selectedArticle?.id === articleId) return this.selectedArticle.tag_ids
      const listItem = this.articleItems.find((article) => article.id === articleId)
      if (listItem) return listItem.tag_ids
      for (const articles of Object.values(this.feedArticleCache)) {
        const cached = articles.find((article) => article.id === articleId)
        if (cached) return cached.tag_ids
      }
      return []
    },
    updateTagCountsForArticle(oldTagIds: number[], newTagIds: number[]) {
      const oldSet = new Set(oldTagIds)
      const newSet = new Set(newTagIds)
      const nextByTag = { ...this.articleCounts.by_tag }
      oldSet.forEach((tagId) => {
        if (!newSet.has(tagId)) {
          nextByTag[tagId] = Math.max(0, (nextByTag[tagId] ?? 0) - 1)
        }
      })
      newSet.forEach((tagId) => {
        if (!oldSet.has(tagId)) {
          nextByTag[tagId] = (nextByTag[tagId] ?? 0) + 1
        }
      })
      this.articleCounts = { ...this.articleCounts, by_tag: nextByTag }
    },
    applyArticleTagIds(articleId: number, tagIds: number[]) {
      const normalizedTagIds = normalizeTagIds(tagIds)
      const oldTagIds = this.articleTagIds(articleId)
      const item = this.articleItems.find((article) => article.id === articleId)
      if (item) this.replaceArticleItem({ ...item, tag_ids: normalizedTagIds })

      const nextCache: Record<number, ArticleListItem[]> = {}
      Object.entries(this.feedArticleCache).forEach(([feedId, articles]) => {
        nextCache[Number(feedId)] = articles.map((article) =>
          article.id === articleId ? { ...article, tag_ids: normalizedTagIds } : article
        )
      })
      this.feedArticleCache = nextCache

      const detail = this.detailCache[articleId]
      if (detail) {
        this.detailCache = { ...this.detailCache, [articleId]: { ...detail, tag_ids: normalizedTagIds } }
      }
      if (this.selectedArticle?.id === articleId) {
        this.selectedArticle = { ...this.selectedArticle, tag_ids: normalizedTagIds }
      }
      this.updateTagCountsForArticle(oldTagIds, normalizedTagIds)
      this.articleMutationVersion += 1
    },
    upsertTag(tag: Tag) {
      const index = this.tags.findIndex((item) => item.id === tag.id)
      if (index >= 0) {
        const next = [...this.tags]
        next.splice(index, 1, tag)
        this.tags = next
        return
      }
      this.tags = [...this.tags, tag]
    },
    async createTag(payload: { name: string; color: string }) {
      const name = payload.name.trim()
      if (!name) throw new Error('Tag name is required')
      const existing = this.tags.find((tag) => tag.name.trim().toLowerCase() === name.toLowerCase())
      if (existing) return existing
      const created = await rssApi.createTag({ name, color: payload.color })
      this.upsertTag(created)
      return created
    },
    removeTagFromLocalState(tagId: number) {
      this.tags = this.tags.filter((tag) => tag.id !== tagId)
      this.articleItems = this.articleItems.map((article) => ({
        ...article,
        tag_ids: article.tag_ids.filter((id) => id !== tagId)
      }))
      const nextCache: Record<number, ArticleListItem[]> = {}
      Object.entries(this.feedArticleCache).forEach(([feedId, articles]) => {
        nextCache[Number(feedId)] = articles.map((article) => ({
          ...article,
          tag_ids: article.tag_ids.filter((id) => id !== tagId)
        }))
      })
      this.feedArticleCache = nextCache
      this.detailCache = Object.fromEntries(
        Object.entries(this.detailCache).map(([articleId, article]) => [
          articleId,
          { ...article, tag_ids: article.tag_ids.filter((id) => id !== tagId) }
        ])
      )
      if (this.selectedArticle) {
        this.selectedArticle = {
          ...this.selectedArticle,
          tag_ids: this.selectedArticle.tag_ids.filter((id) => id !== tagId)
        }
      }
      const nextByTag = { ...this.articleCounts.by_tag }
      delete nextByTag[tagId]
      this.articleCounts = { ...this.articleCounts, by_tag: nextByTag }
      this.articleMutationVersion += 1
    },
    async deleteTag(tagId: number) {
      if (tagId < 0) throw new Error('此标签尚未保存，无法删除持久数据')
      await rssApi.deleteTag(tagId)
      this.removeTagFromLocalState(tagId)
    },
    adjustUnreadCount(delta: number) {
      this.articleCounts = { ...this.articleCounts, unread: Math.max(0, this.articleCounts.unread + delta) }
    },
    adjustStarredCount(delta: number) {
      this.articleCounts = { ...this.articleCounts, starred: Math.max(0, this.articleCounts.starred + delta) }
    },
    async ensureSelectedArticle() {
      if (!this.articleItems.length) {
        this.selectedArticle = null
        return
      }
      const selectedId = this.selectedArticle?.id
      if (!selectedId || !this.articleItems.some((article) => article.id === selectedId)) {
        await this.selectArticle(this.articleItems[0].id, { markRead: false })
      }
    },
    async selectArticle(id: number, options: { markRead?: boolean } = {}) {
      const cached = this.detailCache[id]
      const article = cached ?? await rssApi.article(id)
      this.detailCache = { ...this.detailCache, [id]: article }
      this.selectedArticle = article
      if (options.markRead !== false && !article.is_read) {
        if (this.isCachedArticle(article.id)) {
          this.replaceArticle({ ...article, is_read: true })
          this.replaceCachedArticleItem(toListItem({ ...article, is_read: true }))
          this.adjustUnreadCount(-1)
          return
        }
        const updated = await rssApi.markRead(article.id, true)
        this.replaceArticle(updated)
        await this.loadCounts()
      }
    },
    mergeArticles(articles: ArticleListItem[]) {
      const articleMap = new Map(this.articleItems.map((article) => [article.id, article]))
      articles.forEach((article) => articleMap.set(article.id, article))
      this.articleItems = sortArticles(Array.from(articleMap.values()), this.pinnedArticleIds, this.articleSortOrder)
      this.articleMutationVersion += 1
    },
    async refreshFeedArticles(feedId: number, options: { merge?: boolean } = {}) {
      const page = await rssApi.articles({ feed_id: feedId, limit: ARTICLE_PAGE_SIZE, offset: 0, sort_order: this.articleSortOrder })
      this.feedArticleCache = {
        ...this.feedArticleCache,
        [feedId]: sortArticles(page.items, this.pinnedArticleIds, this.articleSortOrder)
      }
      if (options.merge !== false) {
        this.mergeArticles(page.items)
      }
      this.setFeedArticleCount(feedId, page.total)
      await this.loadCounts()
    },
    upsertFeed(feed: Feed) {
      const index = this.feeds.findIndex((item) => item.id === feed.id)
      if (index >= 0) {
        this.feeds.splice(index, 1, feed)
        return
      }
      this.feeds = [feed, ...this.feeds]
    },
    setFeeds(feeds: Feed[], options: { merge?: boolean } = {}) {
      if (!options.merge) {
        this.feeds = feeds
        return
      }
      const feedMap = new Map<number, Feed>()
      this.feeds.forEach((feed) => feedMap.set(feed.id, feed))
      feeds.forEach((feed) => feedMap.set(feed.id, feed))
      this.feeds = Array.from(feedMap.values())
    },
    removeFeeds(feedIds: number[]) {
      const ids = new Set(feedIds)
      this.feeds = this.feeds.filter((feed) => !ids.has(feed.id))
      this.articleItems = this.articleItems.filter((article) => !ids.has(article.feed_id))
      this.feedArticleCache = Object.fromEntries(
        Object.entries(this.feedArticleCache).filter(([feedId]) => !ids.has(Number(feedId)))
      )
      this.detailCache = Object.fromEntries(
        Object.entries(this.detailCache).filter(([, article]) => !ids.has(article.feed_id))
      )
      this.protectedFeedCounts = Object.fromEntries(
        Object.entries(this.protectedFeedCounts).filter(([feedId]) => !ids.has(Number(feedId)))
      )
      this.articleMutationVersion += 1
      if (this.selectedArticle && ids.has(this.selectedArticle.feed_id)) {
        this.selectedArticle = this.articleItems[0] ? this.detailCache[this.articleItems[0].id] ?? null : null
      }
    },
    async toggleRead(article: ArticleListItem | Article) {
      if (this.isCachedArticle(article.id)) {
        const updated = { ...article, is_read: !article.is_read }
        this.replaceArticleItem(toListItem(updated as Article))
        this.replaceCachedArticleItem(toListItem(updated as Article))
        this.adjustUnreadCount(updated.is_read ? -1 : 1)
        if (this.selectedArticle?.id === article.id) {
          this.selectedArticle = { ...(this.selectedArticle ?? toArticle(toListItem(updated as Article))), is_read: updated.is_read }
        }
        return
      }
      const updated = await rssApi.markRead(article.id, !article.is_read)
      this.replaceArticle(updated)
      await this.loadCounts()
    },
    async toggleStar(article: ArticleListItem | Article) {
      if (this.isCachedArticle(article.id)) {
        const updated = { ...article, is_starred: !article.is_starred }
        this.replaceArticleItem(toListItem(updated as Article))
        this.replaceCachedArticleItem(toListItem(updated as Article))
        this.adjustStarredCount(updated.is_starred ? 1 : -1)
        if (this.selectedArticle?.id === article.id) {
          this.selectedArticle = { ...(this.selectedArticle ?? toArticle(toListItem(updated as Article))), is_starred: updated.is_starred }
        }
        return
      }
      const updated = await rssApi.markStarred(article.id, !article.is_starred)
      this.replaceArticle(updated)
      await this.loadCounts()
    },
    async setArticleTags(articleId: number, tagIds: number[]) {
      const normalizedTagIds = normalizeTagIds(tagIds)
      if (normalizedTagIds.some(tagId => tagId < 0)) {
        throw new Error('请等待标签持久化完成，再保存标签关联')
      }
      await rssApi.setArticleTags(articleId, normalizedTagIds)
      this.applyArticleTagIds(articleId, normalizedTagIds)
      await this.loadCounts()
    },
    togglePinned(articleId: number) {
      const set = new Set(this.pinnedArticleIds)
      if (set.has(articleId)) {
        set.delete(articleId)
      } else {
        set.add(articleId)
      }
      const pinned = Array.from(set)
      persistentStorage.setItem(PINNED_ARTICLES_KEY, JSON.stringify(pinned))
      this.pinnedArticleIds = pinned
      this.articleItems = sortArticles(this.articleItems, this.pinnedArticleIds, this.articleSortOrder)
    },
    isPinned(articleId: number) {
      return this.pinnedArticleIds.includes(articleId)
    },
    hasArticle(articleId: number) {
      return (
        this.articleItems.some((article) => article.id === articleId) ||
        Boolean(this.detailCache[articleId]) ||
        Object.values(this.feedArticleCache).some((articles) => articles.some((article) => article.id === articleId))
      )
    },
    setSummaryLineCount(value: number) {
      const normalized = Number.isFinite(value) && value >= 1 && value <= 5 ? Math.round(value) : 2
      persistentStorage.setItem(SUMMARY_LINES_KEY, String(normalized))
      this.summaryLineCount = normalized
    },
    setShowThumbnails(value: boolean) {
      persistentStorage.setItem(SHOW_THUMBNAILS_KEY, String(value))
      this.showThumbnails = value
    },
    setLeftSidebarVisible(value: boolean) {
      persistentStorage.setItem(LEFT_SIDEBAR_VISIBLE_KEY, String(value))
      this.leftSidebarVisible = value
    },
    setArticleListVisible(value: boolean) {
      persistentStorage.setItem(ARTICLE_LIST_VISIBLE_KEY, String(value))
      this.articleListVisible = value
    },
    setFilterPanelExpanded(value: boolean) {
      persistentStorage.setItem(FILTER_PANEL_EXPANDED_KEY, String(value))
      this.filterPanelExpanded = value
    },
    setFeedPanelExpanded(value: boolean) {
      persistentStorage.setItem(FEED_PANEL_EXPANDED_KEY, String(value))
      this.feedPanelExpanded = value
    },
    setTagPanelExpanded(value: boolean) {
      persistentStorage.setItem(TAG_PANEL_EXPANDED_KEY, String(value))
      this.tagPanelExpanded = value
    },
    setArticleSortOrder(value: SortOrder) {
      persistentStorage.setItem(ARTICLE_SORT_ORDER_KEY, value)
      this.articleSortOrder = value
      this.articleItems = sortArticles(this.articleItems, this.pinnedArticleIds, this.articleSortOrder)
    },
    replaceArticle(article: Article) {
      this.detailCache = { ...this.detailCache, [article.id]: article }
      this.replaceArticleItem(toListItem(article))
      if (this.selectedArticle?.id === article.id) {
        this.selectedArticle = article
      }
    },
    replaceArticleItem(article: ArticleListItem) {
      const index = this.articleItems.findIndex((item) => item.id === article.id)
      if (index >= 0) {
        const next = [...this.articleItems]
        next.splice(index, 1, article)
        this.articleItems = sortArticles(next, this.pinnedArticleIds, this.articleSortOrder)
      }
      this.articleMutationVersion += 1
    },
    withSort(query: ArticleListQuery): ArticleListQuery {
      return { ...query, sort_order: query.sort_order ?? this.articleSortOrder }
    }
  }
})
