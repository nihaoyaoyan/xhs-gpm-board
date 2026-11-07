import type { ThemeConfig } from 'antd';

export const XHS_RED = '#FF2442';

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: XHS_RED,
    colorInfo: XHS_RED,
    colorLink: XHS_RED,
    borderRadius: 8,
    fontSize: 14,
    colorBgLayout: '#f4f6f8',
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      siderBg: '#ffffff',
      bodyBg: '#f4f6f8',
    },
    Menu: {
      itemSelectedBg: 'rgba(255, 36, 66, 0.08)',
      itemSelectedColor: XHS_RED,
      itemBorderRadius: 8,
    },
    Card: {
      borderRadiusLG: 12,
    },
    Button: {
      primaryShadow: 'none',
    },
    Table: {
      headerBg: '#fafafa',
    },
  },
};
