import {
  CommentOutlined,
  DashboardOutlined,
  FileSearchOutlined,
  LineChartOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NotificationOutlined,
  SearchOutlined,
  ShopOutlined,
  TagsOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import { useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import DateRangeBar from '@/components/DateRangeBar';
import ShopSwitcher from '@/components/ShopSwitcher';
import { useAuthStore } from '@/stores/auth';

const { Header, Sider, Content } = Layout;

const MENU_ITEMS = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '经营总览' },
  { key: '/trends', icon: <LineChartOutlined />, label: '趋势分析' },
  { key: '/ad-search-terms', icon: <SearchOutlined />, label: '广告搜索词' },
  { key: '/shop-search-terms', icon: <TagsOutlined />, label: '店铺搜索词' },
  { key: '/note-search-terms', icon: <FileSearchOutlined />, label: '笔记搜索词' },
  { key: '/ads', icon: <NotificationOutlined />, label: '广告投放' },
  { key: '/comments', icon: <CommentOutlined />, label: '评论洞察' },
  { key: '/shops', icon: <ShopOutlined />, label: '店铺管理' },
];

export default function MainLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  const selectedKey = MENU_ITEMS.find((item) => location.pathname.startsWith(item.key))?.key;
  const hideDateRange = location.pathname.startsWith('/shop-search-terms');

  return (
    <Layout className="app-shell">
      <Sider
        className="app-sider"
        theme="light"
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        width={208}
        breakpoint="lg"
        collapsedWidth={72}
      >
        <div className="app-logo" style={{ height: 56, padding: '0 16px' }}>
          <span className="app-logo-badge">薯</span>
          <span style={{ color: '#1f1f1f' }}>小红书数据台</span>
        </div>
        <Menu
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>

      <Layout>
        <Header className="app-header">
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed((value) => !value)}
            className="hide-sm"
          />
          <ShopSwitcher />
          {!hideDateRange && <DateRangeBar />}
          <div className="app-header-spacer" />
          <Dropdown
            menu={{
              items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录' }],
              onClick: ({ key }) => {
                if (key === 'logout') {
                  logout();
                  navigate('/login', { replace: true });
                }
              },
            }}
          >
            <Space style={{ cursor: 'pointer' }}>
              <Avatar size={28} icon={<UserOutlined />} style={{ backgroundColor: '#FF2442' }} />
              <Typography.Text className="hide-sm">{user?.username ?? '管理员'}</Typography.Text>
            </Space>
          </Dropdown>
        </Header>

        <Content style={{ padding: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
