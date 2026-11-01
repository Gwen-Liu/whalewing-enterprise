import { createContext, useContext } from 'react';

// 当前登录的管理员、接口调用、页面跳转、部门和成员名单。
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
