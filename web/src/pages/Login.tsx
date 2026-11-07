import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth';

const schema = z.object({
  username: z.string().min(2, '账号至少 2 个字符').max(64, '账号过长'),
  password: z.string().min(6, '密码至少 6 个字符').max(128, '密码过长'),
});

type FormValues = z.infer<typeof schema>;

export default function Login() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: 'admin', password: 'Admin@12345' },
  });

  const loginMutation = useMutation({
    mutationFn: (values: FormValues) => api.login(values.username, values.password),
    onSuccess: (data) => {
      setAuth(data.access_token, data.user);
      navigate('/dashboard', { replace: true });
    },
  });

  const onSubmit = handleSubmit((values) => {
    loginMutation.mutate(values);
  });

  return (
    <div className="login-page">
      <Card className="login-card" variant="borderless">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            className="app-logo-badge"
            style={{ width: 44, height: 44, fontSize: 20, margin: '0 auto 12px' }}
          >
            薯
          </div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            小红书数据分析工作台
          </Typography.Title>
          <Typography.Text type="secondary">
            店铺 · 订单 · 广告 · 评论 · GPM 一站式经营洞察
          </Typography.Text>
        </div>

        <Form layout="vertical" onFinish={onSubmit}>
          <Form.Item
            label="账号"
            validateStatus={errors.username ? 'error' : undefined}
            help={errors.username?.message}
          >
            <Controller
              name="username"
              control={control}
              render={({ field }) => (
                <Input {...field} size="large" prefix={<UserOutlined />} placeholder="请输入账号" />
              )}
            />
          </Form.Item>

          <Form.Item
            label="密码"
            validateStatus={errors.password ? 'error' : undefined}
            help={errors.password?.message}
          >
            <Controller
              name="password"
              control={control}
              render={({ field }) => (
                <Input.Password
                  {...field}
                  size="large"
                  prefix={<LockOutlined />}
                  placeholder="请输入密码"
                  onPressEnter={onSubmit}
                />
              )}
            />
          </Form.Item>

          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={loginMutation.isPending}
          >
            进入工作台
          </Button>
        </Form>

        <Alert
          style={{ marginTop: 20 }}
          type="info"
          showIcon
          message="演示账号：admin / Admin@12345"
        />
      </Card>
    </div>
  );
}
