import { DatePicker } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useFilterStore } from '@/stores/filter';

const { RangePicker } = DatePicker;

export default function DateRangeBar() {
  const start = useFilterStore((state) => state.start);
  const end = useFilterStore((state) => state.end);
  const setRange = useFilterStore((state) => state.setRange);

  const presets = [
    { label: '近 7 天', value: [dayjs().subtract(6, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: '近 30 天', value: [dayjs().subtract(29, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: '近 90 天', value: [dayjs().subtract(89, 'day'), dayjs()] as [Dayjs, Dayjs] },
  ];

  return (
    <RangePicker
      allowClear={false}
      value={[dayjs(start), dayjs(end)]}
      presets={presets}
      onChange={(values) => {
        if (!values || !values[0] || !values[1]) return;
        setRange(values[0].format('YYYY-MM-DD'), values[1].format('YYYY-MM-DD'));
      }}
      style={{ width: 250 }}
      className="hide-sm"
    />
  );
}
