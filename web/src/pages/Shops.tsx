import { CloudSyncOutlined, EditOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { api } from '@/api';
import type { Shop, SyncLogItem } from '@/api/types';
import { useFilterStore } from '@/stores/filter';
import { RESOURCE_LABELS, fmtDateTime, fmtNumber } from '@/utils/format';

const costSchema = z.object({
  cost_rate: z.number().min(0, '不能小于 0').max(1, '不能大于 1'),
  platform_fee_rate: z.number().min(0, '不能小于 0').max(1, '不能大于 1'),
  return_rate: z.number().min(0, '不能小于 0').max(1, '不能大于 1'),
  monthly_fixed_cost: z.number().min(0, '不能小于 0'),
});

type CostFormValues = z.infer<typeof costSchema>;

const RESOURCES = ['products', 'orders', 'ads', 'comments', 'search_terms'];

export default function Shops() {
  const queryClient = useQueryClient();
  const activeShopId = useFilterStore((state) => state.shopId);
  const setShopId = useFilterStore((state) => state.setShopId);

  const [createOpen, setCreateOpen] = useState(false);
  const [editingShop, setEditingShop] = useState<Shop | null>(null);
  const [syncShop, setSyncShop] = useState<Shop | null>(null);
  const [resource, setResource] = useState('orders');
  const [mode, setMode] = useState('incremental');
  const [days, setDays] = useState(30);

  const [createForm] = Form.useForm<{
    name: string;
    qianfan_shop_id: string;
    app_key?: string;
    app_secret?: string;
  }>();
  const [editForm] = Form.useForm<{
    name: string;
    status: string;
    app_key?: string;
    app_secret?: string;
  }>();

  const shopsQuery = useQuery({ queryKey: ['shops'], queryFn: api.listShops });

  const costQuery = useQuery({
    queryKey: ['cost-config', activeShopId],
    queryFn: () => api.getCostConfig(activeShopId as number),
    enabled: activeShopId !== null,
  });

  const { control, handleSubmit, reset, formState: { errors } } = useForm<CostFormValues>({
    resolver: zodResolver(costSchema),
    defaultValues: { cost_rate: 0.45, platform_fee_rate: 0.05, return_rate: 0.08, monthly_fixed_cost: 3000 },
  });

  useEffect(() => {
    if (costQuery.data) {
      reset({
        cost_rate: costQuery.data.cost_rate,
        platform_fee_rate: costQuery.data.platform_fee_rate,
        return_rate: costQuery.data.return_rate,
        monthly_fixed_cost: costQuery.data.monthly_fixed_cost,
      });
    }
  }, [costQuery.data, reset]);

  const logsQuery = useQuery({
    queryKey: ['sync-logs', syncShop?.id],
    queryFn: () => api.syncLogs(syncShop?.id as number),
    enabled: syncShop !== null,
  });

  const createMutation = useMutation({
    mutationFn: (values: { name: string; qianfan_shop_id: string; app_key?: string; app_secret?: string }) =>
      api.createShop(values),
    onSuccess: (shop) => {
      message.success('店铺创建成功');
      setCreateOpen(false);
      createForm.resetFields();
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      setShopId(shop.id);
    },
  });

  const editMutation = useMutation({
    mutationFn: (values: { name: string; status: string; app_key?: string; app_secret?: string }) =>
      api.updateShop(editingShop!.id, {
        name: values.name,
        status: values.status,
        app_key: values.app_key || undefined,
        app_secret: values.app_secret || undefined,
      }),
    onSuccess: () => {
      message.success('店铺信息已更新');
      setEditingShop(null);
      queryClient.invalidateQueries({ queryKey: ['shops'] });
    },
  });

  const costMutation = useMutation({
    mutationFn: (values: CostFormValues) => api.updateCostConfig(activeShopId as number, values),
    onSuccess: () => {
      message.success('成本参数已保存，指标将按新参数重算');
      queryClient.invalidateQueries();
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncShop(syncShop!.id, resource, mode, days),
    onSuccess: (result) => {
      message.success(`同步完成，拉取 ${result.fetched} 条数据`);
      queryClient.invalidateQueries({ queryKey: ['sync-logs', syncShop?.id] });
      queryClient.invalidateQueries();
    },
  });

  const shops = shopsQuery.data ?? [];

  const columns = [
    {
      title: '店铺名称',
      dataIndex: 'name',
      render: (value: string, row: Shop) => (
        <Space>
          <Typography.Text strong>{value}</Typography.Text>
          {row.id === activeShopId && <Tag color="red">当前</Tag>}
        </Space>
      ),
    },
    { title: '千帆店铺 ID', dataIndex: 'qianfan_shop_id' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: string) => (
        <Tag color={value === 'active' ? 'green' : 'red'}>{value === 'active' ? '启用' : '停用'}</Tag>
      ),
    },
    {
      title: 'API 凭证',
      dataIndex: 'has_credentials',
      width: 110,
      render: (value: boolean) =>
        value ? <Tag color="blue">已配置</Tag> : <Tag>未配置</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      render: (_: unknown, row: Shop) => (
        <Space size={0} wrap>
          <Button type="link" size="small" onClick={() => setShopId(row.id)}>
            切换
          </Button>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingShop(row);
              editForm.setFieldsValue({
                name: row.name,
                status: row.status,
                app_key: undefined,
                app_secret: undefined,
              });
            }}
          >
            编辑
          </Button>
          <Button type="link" size="small" icon={<CloudSyncOutlined />} onClick={() => setSyncShop(row)}>
            同步
          </Button>
        </Space>
      ),
    },
  ];

  const syncLogColumns = [
    { title: '资源', dataIndex: 'resource', render: (value: string) => RESOURCE_LABELS[value] ?? value },
    { title: '方式', dataIndex: 'mode', render: (value: string) => (value === 'backfill' ? '回填' : '增量') },
    { title: '条数', dataIndex: 'fetched_count', render: (value: number) => fmtNumber(value) },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: string) => (
        <Tag color={value === 'success' ? 'green' : value === 'failed' ? 'red' : 'processing'}>
          {value === 'success' ? '成功' : value === 'failed' ? '失败' : '进行中'}
        </Tag>
      ),
    },
    { title: '开始时间', dataIndex: 'started_at', render: (value: string | null) => fmtDateTime(value) },
    { title: '耗时/消息', dataIndex: 'message', ellipsis: true, render: (value: string | null) => value || '—' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="店铺列表"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新增店铺
          </Button>
        }
      >
        <Table<Shop>
          rowKey="id"
          size="small"
          loading={shopsQuery.isLoading}
          columns={columns as never}
          dataSource={shops}
          pagination={false}
          scroll={{ x: 800 }}
        />
      </Card>

      <Card
        size="small"
        title="成本与毛利参数"
        extra={<Tag color="red">当前店铺：{shops.find((shop) => shop.id === activeShopId)?.name ?? '未选择'}</Tag>}
      >
        <Form layout="vertical" onFinish={handleSubmit((values) => costMutation.mutate(values))}>
          <Row gutter={16}>
            <Col xs={24} md={6}>
              <Form.Item
                label="商品成本率"
                validateStatus={errors.cost_rate ? 'error' : undefined}
                help={errors.cost_rate?.message ?? '进货成本 / 售价，例如 0.45 表示 45%'}
              >
                <Controller
                  name="cost_rate"
                  control={control}
                  render={({ field }) => (
                    <InputNumber
                      {...field}
                      min={0}
                      max={1}
                      step={0.01}
                      style={{ width: '100%' }}
                      value={field.value}
                      onChange={(value) => field.onChange(value ?? 0)}
                    />
                  )}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item
                label="平台佣金率"
                validateStatus={errors.platform_fee_rate ? 'error' : undefined}
                help={errors.platform_fee_rate?.message ?? '小红书平台技术服务费比例'}
              >
                <Controller
                  name="platform_fee_rate"
                  control={control}
                  render={({ field }) => (
                    <InputNumber
                      {...field}
                      min={0}
                      max={1}
                      step={0.01}
                      style={{ width: '100%' }}
                      value={field.value}
                      onChange={(value) => field.onChange(value ?? 0)}
                    />
                  )}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item
                label="退款率"
                validateStatus={errors.return_rate ? 'error' : undefined}
                help={errors.return_rate?.message ?? '预估退款比例，用于毛利测算'}
              >
                <Controller
                  name="return_rate"
                  control={control}
                  render={({ field }) => (
                    <InputNumber
                      {...field}
                      min={0}
                      max={1}
                      step={0.01}
                      style={{ width: '100%' }}
                      value={field.value}
                      onChange={(value) => field.onChange(value ?? 0)}
                    />
                  )}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item
                label="每月固定成本（元）"
                validateStatus={errors.monthly_fixed_cost ? 'error' : undefined}
                help={errors.monthly_fixed_cost?.message ?? '房租、人力、软件等月度固定支出'}
              >
                <Controller
                  name="monthly_fixed_cost"
                  control={control}
                  render={({ field }) => (
                    <InputNumber
                      {...field}
                      min={0}
                      step={100}
                      style={{ width: '100%' }}
                      value={field.value}
                      onChange={(value) => field.onChange(value ?? 0)}
                    />
                  )}
                />
              </Form.Item>
            </Col>
          </Row>
          <Space>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SettingOutlined />}
              loading={costMutation.isPending}
              disabled={activeShopId === null}
            >
              保存并重算指标
            </Button>
            <Button onClick={() => costQuery.refetch()} disabled={activeShopId === null}>
              重置
            </Button>
          </Space>
        </Form>
      </Card>

      <Modal
        title="新增店铺"
        open={createOpen}
        confirmLoading={createMutation.isPending}
        onCancel={() => setCreateOpen(false)}
        onOk={() => {
          createForm
            .validateFields()
            .then((values) =>
              createMutation.mutateAsync({
                name: values.name,
                qianfan_shop_id: values.qianfan_shop_id,
                app_key: values.app_key || undefined,
                app_secret: values.app_secret || undefined,
              }),
            )
            .catch(() => undefined);
        }}
        okText="创建"
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="name" label="店铺名称" rules={[{ required: true, message: '请输入店铺名称' }]}>
            <Input placeholder="例如：鲜水湾旗舰店" />
          </Form.Item>
          <Form.Item
            name="qianfan_shop_id"
            label="千帆店铺 ID"
            rules={[{ required: true, message: '请输入千帆店铺 ID' }]}
          >
            <Input placeholder="XHS-SHOP-001" />
          </Form.Item>
          <Form.Item name="app_key" label="App Key（可选）">
            <Input placeholder="千帆开放平台 App Key" />
          </Form.Item>
          <Form.Item name="app_secret" label="App Secret（可选）">
            <Input.Password placeholder="千帆开放平台 App Secret" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`编辑店铺 · ${editingShop?.name ?? ''}`}
        open={editingShop !== null}
        confirmLoading={editMutation.isPending}
        onCancel={() => setEditingShop(null)}
        onOk={() => {
          editForm
            .validateFields()
            .then((values) => editMutation.mutateAsync(values))
            .catch(() => undefined);
        }}
        okText="保存"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="店铺名称" rules={[{ required: true, message: '请输入店铺名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'active', label: '启用' },
                { value: 'disabled', label: '停用' },
              ]}
            />
          </Form.Item>
          <Form.Item name="app_key" label="App Key（留空则不修改）">
            <Input placeholder="更新千帆 App Key" />
          </Form.Item>
          <Form.Item name="app_secret" label="App Secret（留空则不修改）">
            <Input.Password placeholder="更新千帆 App Secret" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={`数据同步 · ${syncShop?.name ?? ''}`}
        open={syncShop !== null}
        width={720}
        onClose={() => setSyncShop(null)}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Card size="small" title="手动触发同步">
            <Space wrap>
              <Select
                value={resource}
                onChange={setResource}
                style={{ width: 130 }}
                options={RESOURCES.map((item) => ({ value: item, label: RESOURCE_LABELS[item] }))}
              />
              <Select
                value={mode}
                onChange={setMode}
                style={{ width: 120 }}
                options={[
                  { value: 'incremental', label: '增量同步' },
                  { value: 'backfill', label: '历史回填' },
                ]}
              />
              <InputNumber
                min={1}
                max={365}
                value={days}
                onChange={(value) => setDays(value ?? 30)}
                addonAfter="天"
                style={{ width: 130 }}
                disabled={mode !== 'backfill'}
              />
              <Button
                type="primary"
                icon={<CloudSyncOutlined />}
                loading={syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
              >
                开始同步
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
              Mock 数据源下可直接使用；接入千帆时请先在店铺编辑中配置 App Key / Secret，并替换 qianfan.py 中的接口路径与字段映射。
            </Typography.Paragraph>
          </Card>

          <Card
            size="small"
            title="同步日志"
            extra={<Button size="small" onClick={() => logsQuery.refetch()}>刷新</Button>}
          >
            <Table<SyncLogItem>
              rowKey="id"
              size="small"
              loading={logsQuery.isLoading}
              columns={syncLogColumns as never}
              dataSource={logsQuery.data ?? []}
              pagination={{ pageSize: 8, showSizeChanger: false }}
            />
          </Card>
        </Space>
      </Drawer>
    </Space>
  );
}
