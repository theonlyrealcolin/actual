// @ts-strict-ignore
import React from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';

import { Text } from '@actual-app/components/text';

import { useScheduledTransactions } from '#components/budget/ScheduledTransactionsContext';
import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { useFormat } from '#hooks/useFormat';
import type { FormatType } from '#hooks/useFormat';
import { useSheetName } from '#hooks/useSheetName';
import { useSheetValue } from '#hooks/useSheetValue';
import type {
  Binding,
  SheetFields,
  SheetNames,
  Spreadsheets,
} from '#spreadsheet';

type CellValueProps<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
> = {
  children?: ({
    type,
    name,
    value,
  }: {
    type?: FormatType;
    name: string;
    value: Spreadsheets[SheetName][FieldName];
  }) => ReactNode;
  binding: Binding<SheetName, FieldName>;
  type?: FormatType;
};

export function CellValue<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>({ type, binding, children, ...props }: CellValueProps<SheetName, FieldName>) {
  const { sheetName, bindingName, fullSheetName } = useSheetName(binding);
  const sheetValue = useSheetValue(binding);
  const { adjustValue } = useScheduledTransactions();

  const numericValue =
    typeof sheetValue === 'number' ? sheetValue : Number(sheetValue) || 0;
  const { value: adjustedValue } = adjustValue(
    bindingName,
    sheetName,
    numericValue,
  );
  const displayValue = (typeof sheetValue === 'number'
    ? adjustedValue
    : isNaN(Number(sheetValue))
      ? sheetValue
      : adjustedValue) as unknown as Spreadsheets[SheetName][FieldName];

  return typeof children === 'function' ? (
    <>{children({ type, name: fullSheetName, value: displayValue })}</>
  ) : (
    <CellValueText
      type={type}
      name={fullSheetName}
      value={displayValue}
      {...props}
    />
  );
}

const PRIVACY_FILTER_TYPES = ['financial', 'financial-with-sign'];

type CellValueTextProps<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
> = Omit<ComponentPropsWithoutRef<typeof Text>, 'value' | 'as'> & {
  type?: FormatType;
  name: string;
  value: Spreadsheets[SheetName][FieldName];
  style?: CSSProperties;
  formatter?: (
    value: Spreadsheets[SheetName][FieldName],
    type?: FormatType,
  ) => string;
};

export function CellValueText<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>({
  type,
  name,
  value,
  formatter,
  style,
  ...props
}: CellValueTextProps<SheetName, FieldName>) {
  const format = useFormat();
  const { adjustValue } = useScheduledTransactions();

  const idx = name.indexOf('!');
  const sheetName = idx !== -1 ? name.slice(0, idx) : '';
  const bindingName = idx !== -1 ? name.slice(idx + 1) : name;

  const numericValue = typeof value === 'number' ? value : Number(value) || 0;
  const { affected } = adjustValue(
    bindingName,
    sheetName,
    0, // Just check if affected, do not apply adjustment again
  );
  const displayValue = value;

  const isSpentCell =
    bindingName.startsWith('sum-amount-') ||
    bindingName.startsWith('group-sum-amount-');
  const isBalanceCell =
    bindingName.startsWith('leftover-') ||
    bindingName.startsWith('group-leftover-');

  let styleOverride = null;
  if (affected) {
    if (isSpentCell) {
      styleOverride = { color: '#a855f7' };
    } else if (isBalanceCell) {
      if (numericValue >= 0) {
        styleOverride = { color: '#a855f7' };
      }
    }
  }

  const isFinancial =
    type === 'financial' ||
    type === 'financial-with-sign' ||
    type === 'financial-no-decimals';
  const sharedProps = {
    style: styleOverride ? { ...style, ...styleOverride } : style,
    'data-testid': name,
    'data-cellname': name,
    ...props,
  };

  if (isFinancial) {
    return (
      <FinancialText
        {...sharedProps}
        style={{
          whiteSpace: 'nowrap',
          ...(styleOverride ? { ...style, ...styleOverride } : style),
        }}
      >
        <PrivacyFilter
          activationFilters={[PRIVACY_FILTER_TYPES.includes(type)]}
        >
          {formatter
            ? formatter(displayValue, type)
            : format(displayValue, type)}
        </PrivacyFilter>
      </FinancialText>
    );
  }

  return (
    <Text {...sharedProps}>
      <PrivacyFilter activationFilters={[PRIVACY_FILTER_TYPES.includes(type)]}>
        {formatter ? formatter(displayValue, type) : format(displayValue, type)}
      </PrivacyFilter>
    </Text>
  );
}
