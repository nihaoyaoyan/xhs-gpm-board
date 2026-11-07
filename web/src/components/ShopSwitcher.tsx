import { ShopOutlined } from '@ant-design/icons';
import { Select, Spin } from 'antd';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import { useFilterStore } from '@/stores/filter';

export default function ShopSwitcher() {
  const shopId = useFilterStore((state) => state.shopId);
  const setShopId = useFilterStore((state) => state.setShopId);

  const { data = [], isLoading } = useQuery({
    queryKey: ['shops'],
    queryFn: api.listShops,
  });

  useEffect(() => {
    if (!data.length) return;
    if (shopId === null || !data.some((shop) => shop.id === shopId)) {
      setShopId(data[0].id);
    }
  }, [data, shopId, setShopId]);

  if (isLoading) {
    return <Spin size="small" />;
  }

  return (
    <Select
      style={{ minWidth: 190, maxWidth: 240 }}
      value={shopId ?? undefined}
      onChange={(value) => setShopId(value)}
      options={data.map((shop) => ({
        value: shop.id,
        label: (
          <span>
            <ShopOutlined style={{ marginRight: 6, color: '#FF2442' }} />
            {shop.name}
          </span>
        ),
      }))}
      placeholder="选择店铺"
    />
  );
}
