export interface FeishuBlockText {
  elements?: {
    text_run?: {
      content?: string;
    };
  }[];
}

export interface FeishuBlockTableProperty {
  row_size?: number;
  column_size?: number;
  column_width?: number[];
}

export interface FeishuBlockTable {
  property?: FeishuBlockTableProperty;
  merge_info?: { row_span?: number; col_span?: number }[];
  cells?: string[];
}

export interface FeishuDocxBlock {
  block_id?: string;
  parent_id?: string;
  children?: string[] | string;
  block_type: number;
  text?: FeishuBlockText;
  table?: FeishuBlockTable;
  image?: object;
  [key: string]: object | string | number | boolean | string[] | undefined;
}

export interface FeishuDocxBlockChild {
  block_id?: string;
  parent_id?: string;
  block_type?: number;
  children?: string[] | FeishuDocxBlockChild[];
  table?: FeishuBlockTable;
}
