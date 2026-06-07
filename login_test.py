from pykiwoom.kiwoom import Kiwoom
import time

kiwoom = Kiwoom()
kiwoom.CommConnect(block=True)

print("로그인 성공!")
print("계좌번호:", kiwoom.GetLoginInfo("ACCNO"))