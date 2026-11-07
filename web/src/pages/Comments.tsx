import { DownloadOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Input, Modal, Rate, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { useState } from 'react';
import { api } from '@/api';
import type { CommentItem } from '@/api/types';
import { useRangeParams } from '@/stores/filter';
import { exportXlsx } from '@/utils/exportXlsx';
import { SENTIMENT_LABELS, fmtDateTime, fmtNumber } from '@/utils/format';

const SENTIMENT_OPTIONS = [
  { value: 'positive', label: '正向' },
  { value: 'neutral', label: '中性' },
  { value: 'negative', label: '负向' },
  { value: 'unanalyzed', label: '未分析' },
];

export default function Comments() {
  const { shop_id, start, end, enabled } = useRangeParams();
  const queryClient = useQueryClient();
  const [sentiment, setSentiment] = useState<string | undefined>();
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const query = useQuery({
    queryKey: ['comments', shop_id, start, end, sentiment, keyword, page, pageSize],
    queryFn: () =>
      api.comments({
        shop_id,
        start,
        end,
        sentiment,
        keyword: keyword || undefined,
        page,
        page_size: pageSize,
      }),
    enabled,
    placeholderData: keepPreviousData,
  });

  const reanalyzeMutation = useMutation({
    mutationFn: () => api.reanalyzeComments(shop_id, 200),
    onSuccess: (data) => {
      message.success(`已重新分析 ${data.analyzed} 条评论`);
      queryClient.invalidateQueries({ queryKey: ['comments'] });
      queryClient.invalidateQueries({ queryKey: ['sentiment'] });
    },
  });

  const analyzeOneMutation = useMutation({
    mutationFn: (commentId: number) => api.analyzeComment(commentId),
    onSuccess: () => {
      message.success('已重新分析');
      queryClient.invalidateQueries({ queryKey: ['comments'] });
      queryClient.invalidateQueries({ queryKey: ['sentiment'] });
    },
  });

  const items = query.data?.items ?? [];

  const columns = [
    {
      title: '评论时间',
      dataIndex: 'comment_at',
      width: 150,
      render: (value: string | null) => fmtDateTime(value),
    },
    {
      title: '评论内容',
      dataIndex: 'content',
      ellipsis: true,
      render: (value: string, row: CommentItem) => (
        <Tooltip title={value} placement="topLeft">
          <div>
            <div>{value}</div>
            {row.product_title && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.product_title}
              </Typography.Text>
            )}
          </div>
        </Tooltip>
      ),
    },
    {
      title: '评分',
      dataIndex: 'rating',
      width: 140,
      render: (value: number) => <Rate disabled value={value} style={{ fontSize: 13 }} />,
    },
    {
      title: '情感',
      dataIndex: 'sentiment',
      width: 130,
      render: (value: string | null, row: CommentItem) => {
        const meta = SENTIMENT_LABELS[value ?? 'unanalyzed'] ?? SENTIMENT_LABELS.unanalyzed;
        return (
          <Space direction="vertical" size={2}>
            <Tag color={meta.color}>{meta.label}</Tag>
            {row.sentiment_score !== null && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                得分 {row.sentiment_score.toFixed(2)}
              </Typography.Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '关键词',
      dataIndex: 'keywords',
      width: 220,
      render: (value: string[]) =>
        value?.length ? (
          <Space size={[0, 4]} wrap>
            {value.slice(0, 4).map((word) => (
              <Tag key={word}>{word}</Tag>
            ))}
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: '点赞',
      dataIndex: 'like_count',
      width: 80,
      render: (value: number) => fmtNumber(value),
    },
    {
      title: '分析通道',
      dataIndex: 'analyzer_type',
      width: 100,
      render: (value: string | null) =>
        value ? <Tag color={value === 'llm' ? 'purple' : 'blue'}>{value === 'llm' ? 'LLM' : '本地'}</Tag> : '—',
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      fixed: 'right' as const,
      render: (_: unknown, row: CommentItem) => (
        <Button
          type="link"
          size="small"
          loading={analyzeOneMutation.isPending}
          onClick={() => analyzeOneMutation.mutate(row.id)}
        >
          重新分析
        </Button>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="评论洞察"
      extra={
        <Space wrap>
          <Select
            allowClear
            placeholder="情感倾向"
            style={{ width: 130 }}
            value={sentiment}
            onChange={(value) => {
              setSentiment(value);
              setPage(1);
            }}
            options={SENTIMENT_OPTIONS}
          />
          <Input.Search
            allowClear
            placeholder="搜索评论关键词"
            style={{ width: 200 }}
            onSearch={(value) => {
              setKeyword(value.trim());
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => query.refetch()}>
            刷新
          </Button>
          <Button
            icon={<ThunderboltOutlined />}
            loading={reanalyzeMutation.isPending}
            onClick={() => {
              Modal.confirm({
                title: '重新分析最近 200 条评论',
                content: '将按当前分析通道重新计算情感与关键词，可能覆盖已有的 LLM 分析结果。',
                okText: '开始分析',
                onOk: () => reanalyzeMutation.mutateAsync(),
              });
            }}
          >
            批量重新分析
          </Button>
          <Button
            icon={<DownloadOutlined />}
            disabled={!items.length}
            onClick={() =>
              exportXlsx(
                '评论明细',
                [
                  { title: '评论时间', dataIndex: 'comment_at' },
                  { title: '商品', dataIndex: 'product_title' },
                  { title: '评论内容', dataIndex: 'content' },
                  { title: '评分', dataIndex: 'rating' },
                  {
                    title: '情感',
                    dataIndex: 'sentiment',
                    formatter: (value) => SENTIMENT_LABELS[value as string]?.label ?? '',
                  },
                  { title: '情感得分', dataIndex: 'sentiment_score' },
                  {
                    title: '关键词',
                    dataIndex: 'keywords',
                    formatter: (value) => (Array.isArray(value) ? value.join('、') : ''),
                  },
                  { title: '点赞数', dataIndex: 'like_count' },
                ],
                items as unknown as Record<string, unknown>[],
              )
            }
          >
            导出当前页
          </Button>
        </Space>
      }
    >
      <Table<CommentItem>
        rowKey="id"
        size="small"
        loading={query.isLoading}
        columns={columns as never}
        dataSource={items}
        scroll={{ x: 1200 }}
        pagination={{
          current: page,
          pageSize,
          total: query.data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条评论`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          },
        }}
      />
    </Card>
  );
}
